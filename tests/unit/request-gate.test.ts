import { describe, it, expect } from 'vitest';
import { RequestGate } from '../../src/ui/request-gate';

describe('RequestGate', () => {
  it('only the newest token is current — stale async responses get discarded', () => {
    const gate = new RequestGate();
    const t1 = gate.issue();
    expect(gate.isCurrent(t1)).toBe(true);
    const t2 = gate.issue();
    expect(gate.isCurrent(t1)).toBe(false); // t1's in-flight response must be dropped
    expect(gate.isCurrent(t2)).toBe(true);
  });
});
