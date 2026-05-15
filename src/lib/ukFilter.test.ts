import test from 'node:test';
import assert from 'node:assert';
import { isUKJob, JobLocationInput } from './ukFilter';

/**
 * ukFilter.test.ts — Unit tests for the UK Filter logic.
 * Run with: npx tsx src/lib/ukFilter.test.ts
 */

test('UK Filter: Trusted source', () => {
    const input: JobLocationInput = {
        isTrustedSource: true,
        locations: [],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), true, 'Trusted source should return true');
});

test('UK Filter: Remote flag', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: [],
        isRemote: true
    };
    assert.strictEqual(isUKJob(input), true, 'isRemote true should return true');
});

test('UK Filter: UK city', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["London"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), true, 'London should return true');
});

test('UK Filter: UK country term', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["United Kingdom"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), true, 'United Kingdom should return true');
});

test('UK Filter: Multi-location with UK', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["New York", "London", "Singapore"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), true, 'Multi-location with London should return true');
});

test('UK Filter: Multi-location no UK', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["New York", "Singapore", "Dubai"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), false, 'Multi-location without UK should return false');
});

test('UK Filter: Hard block only', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["California"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), false, 'California should return false');
});

test('UK Filter: Global signal', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["Global"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), true, 'Global should return true');
});

test('UK Filter: EMEA signal', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["EMEA"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), true, 'EMEA should return true');
});

test('UK Filter: Empty everything', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: [],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), false, 'Empty everything should return false');
});

test('UK Filter: Northern Ireland safety', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["Northern Ireland"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), true, 'Northern Ireland should return true and not be blocked by Ireland');
});

test('UK Filter: Remote UK string', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["Remote UK"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), true, 'Remote UK string should return true');
});

test('UK Filter: Dublin hard block', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["Dublin"],
        isRemote: false
    };
    assert.strictEqual(isUKJob(input), false, 'Dublin should return false');
});

test('UK Filter: Ambiguous remote', () => {
    const input: JobLocationInput = {
        isTrustedSource: false,
        locations: ["Remote"],
        isRemote: false
    };
    // "Remote" in locations string should pass via GLOBAL_SIGNALS
    assert.strictEqual(isUKJob(input), true, 'Bare "Remote" in locations string should return true');
});
