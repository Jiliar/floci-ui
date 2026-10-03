import {afterEach, describe, expect, test} from 'bun:test'
import {GcpComputeAdapter} from './GcpComputeAdapter'
import {GcpRestRuntimeClient} from '../gcp'
import {RuntimeError, ValidationError} from '../cloud-spi/errors'

const originalFetch = globalThis.fetch
const ENDPOINT = 'http://localhost:4588'
const PROJECT_PATH = '/compute/v1/projects/floci-local'
const SELF = 'https://www.googleapis.com/compute/v1/projects/floci-local'

afterEach(() => {
    globalThis.fetch = originalFetch
})

function adapter(): GcpComputeAdapter {
    return new GcpComputeAdapter(new GcpRestRuntimeClient(ENDPOINT, 'floci-local', 'us-central1'))
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    const calls: Array<{url: string; init?: RequestInit}> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({url: String(url), init})
        return handler(String(url), init)
    }) as unknown as typeof fetch
    return calls
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

/** Shape captured from the floci-gcp nightly image. */
function gceInstance(name: string, status = 'RUNNING') {
    return {
        kind: 'compute#instance',
        id: '1008',
        name,
        status,
        zone: `${SELF}/zones/us-central1-a`,
        machineType: `${SELF}/zones/us-central1-a/machineTypes/e2-standard-2`,
        creationTimestamp: '2026-10-03T20:46:21.948001847Z',
        disks: [{boot: true, autoDelete: true, source: `${SELF}/zones/us-central1-a/disks/${name}`, diskSizeGb: '10'}],
        networkInterfaces: [
            {
                network: `${SELF}/global/networks/net1`,
                subnetwork: `${SELF}/regions/us-central1/subnetworks/sub1`,
                name: 'nic0',
                networkIP: '10.0.0.2',
            },
        ],
    }
}

function operation(status: 'PENDING' | 'DONE', error?: unknown) {
    return {kind: 'compute#operation', name: 'operation-1', operationType: 'insert', status, ...(error ? {error} : {})}
}

const validValues = {
    name: 'vm1',
    zone: 'us-central1-a',
    machineType: 'e2-standard-2',
    network: 'net1',
    subnetwork: 'sub1',
}

describe('GcpComputeAdapter', () => {
    test('identifies itself as the GCP compute adapter', () => {
        const instance = adapter()
        expect(instance.cloud).toBe('gcp')
        expect(instance.service).toBe('compute')
        expect(instance.schema().cloud).toBe('gcp')
    })

    test('lists instances across zones from the aggregated list', async () => {
        const calls = stubFetch(() =>
            json({
                items: {
                    'zones/us-central1-a': {instances: [gceInstance('vm1')]},
                    'zones/us-central1-b': {warning: {code: 'NO_RESULTS_ON_PAGE'}},
                },
            }),
        )

        const resources = await adapter().list()

        expect(calls[0].url).toBe(`${ENDPOINT}${PROJECT_PATH}/aggregated/instances`)
        expect(resources).toHaveLength(1)
        expect(resources[0]).toMatchObject({
            id: 'us-central1-a/vm1',
            name: 'vm1',
            cloud: 'gcp',
            service: 'compute',
            type: 'instance',
            region: 'us-central1-a',
            status: 'RUNNING',
            instanceClass: 'e2-standard-2',
        })
        expect(resources[0].metadata).toMatchObject({internalIp: '10.0.0.2', network: 'net1', subnetwork: 'sub1'})
    })

    test('returns an empty list when nothing exists', async () => {
        stubFetch(() => json({kind: 'compute#instanceAggregatedList', items: {}}))
        expect(await adapter().list()).toEqual([])
    })

    test('filters the list by search term', async () => {
        stubFetch(() => json({items: {'zones/us-central1-a': {instances: [gceInstance('web-1'), gceInstance('db-1')]}}}))
        const resources = await adapter().list({search: 'WEB'})
        expect(resources.map((resource) => resource.name)).toEqual(['web-1'])
    })

    test('gets an instance by zone and name', async () => {
        const calls = stubFetch(() => json(gceInstance('vm1', 'TERMINATED')))

        const resource = await adapter().get('us-central1-a/vm1')

        expect(calls[0].url).toBe(`${ENDPOINT}${PROJECT_PATH}/zones/us-central1-a/instances/vm1`)
        expect(resource?.status).toBe('TERMINATED')
    })

    test('returns null when the instance is gone', async () => {
        stubFetch(() => json({error: {code: 404, message: 'not found'}}, 404))
        expect(await adapter().get('us-central1-a/missing')).toBeNull()
    })

    test('rejects an id without a zone', async () => {
        await expect(adapter().get('vm1')).rejects.toBeInstanceOf(ValidationError)
    })

    test('creates an instance, polls the operation and reads it back', async () => {
        let operationReads = 0
        const calls = stubFetch((url, init) => {
            if (init?.method === 'POST') return json(operation('PENDING'))
            if (url.includes('/operations/')) return json(operation(++operationReads > 1 ? 'DONE' : 'PENDING'))
            return json(gceInstance('vm1'))
        })

        const resource = await adapter().create({values: validValues})

        const post = calls[0]
        expect(post.url).toBe(`${ENDPOINT}${PROJECT_PATH}/zones/us-central1-a/instances`)
        expect(JSON.parse(String(post.init?.body))).toEqual({
            name: 'vm1',
            machineType: 'zones/us-central1-a/machineTypes/e2-standard-2',
            disks: [{boot: true, autoDelete: true, initializeParams: {diskSizeGb: '10'}}],
            networkInterfaces: [{network: 'global/networks/net1', subnetwork: 'regions/us-central1/subnetworks/sub1'}],
        })
        expect(operationReads).toBe(2)
        expect(resource.id).toBe('us-central1-a/vm1')
    })

    test('surfaces a failed operation as a runtime error', async () => {
        stubFetch((_url, init) =>
            init?.method === 'POST' ? json(operation('DONE', {errors: [{message: 'quota exceeded'}]})) : json({}),
        )
        await expect(adapter().create({values: validValues})).rejects.toBeInstanceOf(RuntimeError)
    })

    test('validates create input before calling the runtime', async () => {
        const calls = stubFetch(() => json({}))

        await expect(adapter().create({values: {...validValues, name: 'Bad_Name'}})).rejects.toBeInstanceOf(ValidationError)
        await expect(adapter().create({values: {...validValues, zone: 'mars-1-a'}})).rejects.toBeInstanceOf(ValidationError)
        await expect(adapter().create({values: {...validValues, subnetwork: ''}})).rejects.toBeInstanceOf(ValidationError)
        await expect(adapter().create({values: {...validValues, diskSizeGb: '0'}})).rejects.toBeInstanceOf(ValidationError)
        expect(calls).toHaveLength(0)
    })

    test('deletes an instance and tolerates one that is already gone', async () => {
        const calls = stubFetch(() => json({error: {code: 404, message: 'not found'}}, 404))

        await adapter().delete('us-central1-a/vm1')

        expect(calls[0].init?.method).toBe('DELETE')
        expect(calls[0].url).toBe(`${ENDPOINT}${PROJECT_PATH}/zones/us-central1-a/instances/vm1`)
    })

    test('maps start, stop and reboot to start, stop and reset', async () => {
        const calls = stubFetch(() => json(operation('PENDING')))

        await adapter().start('us-central1-a/vm1')
        await adapter().stop('us-central1-a/vm1')
        await adapter().reboot('us-central1-a/vm1')

        expect(calls.map((call) => call.url.split('/').pop())).toEqual(['start', 'stop', 'reset'])
        expect(calls.every((call) => call.init?.method === 'POST')).toBe(true)
    })
})
