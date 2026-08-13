/**
 * Which nodes have a MOUNT-TIME launch write in flight (TerminalNode's `initialCommand` /
 * cold-restore auto-resume, delivered via `writeWhenShellReady`). The loop engine consults this
 * before typing its own launch line into an agent station's pane: both writers target the same
 * shell, and the second line would land INSIDE the freshly launched CLI as typed input.
 *
 * The mark is a timestamp with a TTL rather than a boolean handshake, because
 * `writeWhenShellReady` is fire-and-forget (its settle callback is not guaranteed on every
 * path): a mark that could never be cleared would permanently re-route the engine to the
 * wait-only branch. Within the TTL the engine waits for the agent to report up instead of
 * launching — exactly what it does for a healthy mount launch anyway.
 */

const inFlight = new Map<string, number>()

export const MOUNT_LAUNCH_TTL_MS = 12_000

export function markMountLaunch(nodeId: string): void {
  inFlight.set(nodeId, Date.now() + MOUNT_LAUNCH_TTL_MS)
}

export function clearMountLaunch(nodeId: string): void {
  inFlight.delete(nodeId)
}

export function hasMountLaunch(nodeId: string): boolean {
  const until = inFlight.get(nodeId)
  if (until === undefined) return false
  if (until <= Date.now()) {
    inFlight.delete(nodeId)
    return false
  }
  return true
}
