/**
 * Room coordination shared by the Durable Object (cloudflare/worker.js) and the local relay
 * (server/collaboration.mjs): claims, the authoritative bench state and its revisions.
 *
 * - Every accepted change to a part bumps that part's revision. The room keeps the last
 *   accepted whole-part state ("authoritative") per part.
 * - Claims: holding a part conflicts with anyone holding either of its cable ends, and holding
 *   an end conflicts with anyone holding the whole part (or that same end).
 * - Live drags ("transform"): accepted only from the participant holding the resource; the sender gets
 *   the new revision (`rev-ack`), a rejected sender gets the authoritative state back
 *   (`transform-rejected`), so a refused drag can never leave its sender diverged — even if
 *   the holder disconnects without a final move.
 * - Edits ("edit"): atomic batches of whole-part changes (value edits, undo/redo, import,
 *   reset, return to tray) with the revision each change was based on. All or nothing: refused
 *   if any part is held by someone else or changed since. The sender applies an edit only when
 *   the room accepts it (`edit-result`), and every other client receives it in the room's
 *   order, so concurrent edits cannot leave two clients with different values.
 * - Joiners get the authoritative state, revisions, claims, program and its revision
 *   (`room-state`); a granted claim is confirmed to its holder (`claim-granted`).
 * - Program uploads/stops may be unconditional (`expectRev: null`): still ordered by the room
 *   and applied by everyone (sender included) only when relayed/accepted.
 *
 * - Sound Flow Studio patch cables (sound-rules.js): one plug per jack. A live move or an edit
 *   that would put a second plug into a jack is refused (`transform-rejected` / `edit-result`
 *   reason "occupied") with the room's state, like any other refusal.
 *
 * Pure: no sockets or storage. `handle()` returns what to send and what to persist.
 */

import {
  initialRescueState,
  onParticipantLeft,
  onRoomEmpty,
  onTransmitterChanged,
  reduceRescue,
} from "../src/episodes/rescue-state.ts";
import { isSoundCable, nextCableSockets, soundJackConflict } from "./sound-rules.js";

const resourceParts = (resourceId) => {
  const match = /^(.*)::endpoint-([01])$/.exec(resourceId);
  return match ? { componentId: match[1], endpoint: Number(match[2]) } : { componentId: resourceId, endpoint: null };
};

export class RoomCore {
  /**
   * @param {{ entries?: Array<[string, { transform: object, rev: number }]>, programRev?: number, program?: { program: unknown[], running: boolean } | null }} [initial]
   */
  constructor(initial = {}) {
    /** @type {Map<string, { participantId: string, participantName: string }>} */
    this.claims = new Map();
    /** @type {Map<string, { transform: object, rev: number }>} */
    this.state = new Map(initial.entries ?? []);
    this.programRev = initial.programRev ?? 0;
    this.program = initial.program ?? null;
    /** Rescue Signal episode state (src/episodes/rescue-state.ts); persisted by the host. */
    this.episode = initial.episode ?? initialRescueState();
    /** Server clock (injectable for tests). */
    this.now = initial.now ?? (() => Date.now());
  }

  episodeMessage(program) {
    return {
      kind: "episode-state",
      state: this.episode,
      serverNow: this.now(),
      ...(program ? { program: { ...program, rev: this.programRev } } : {}),
    };
  }

  /**
   * An accepted change touched the Snapino transmitter (a part or the program): a running
   * transmission ends there. Returns the episode update to broadcast to everyone, if any.
   */
  transmitterChanged(componentIds, programChanged, out) {
    const touched = componentIds.some((id) => id.startsWith("sno-"));
    if (!touched && !programChanged) return;
    const next = onTransmitterChanged(this.episode, this.now(), programChanged ? "program-changed" : "bench-changed");
    if (!next) return;
    this.episode = next;
    const update = this.episodeMessage();
    out.sender.push(update);
    out.others.push(update);
    out.persist.episode = this.episode;
  }

  rev(componentId) {
    return this.state.get(componentId)?.rev ?? 0;
  }

  /** Someone other than `participantId` holding `resourceId` or a conflicting resource, if any. */
  conflict(resourceId, participantId) {
    const { componentId, endpoint } = resourceParts(resourceId);
    const keys = endpoint === null
      ? [componentId, `${componentId}::endpoint-0`, `${componentId}::endpoint-1`]
      : [componentId, resourceId];
    for (const key of keys) {
      const claim = this.claims.get(key);
      if (claim && claim.participantId !== participantId) return { resourceId: key, ...claim };
    }
    return null;
  }

  claimMessage(resourceId, claim) {
    return { kind: "claim", participantId: claim.participantId, participantName: claim.participantName, componentId: resourceId };
  }

  authoritative(componentId) {
    const entry = this.state.get(componentId);
    return { componentId, transform: entry ? entry.transform : null, rev: entry ? entry.rev : 0 };
  }

  /** Messages for a participant joining (after their hello). */
  join() {
    const transforms = {};
    for (const [componentId, entry] of this.state) transforms[componentId] = { transform: entry.transform, rev: entry.rev };
    const claims = [...this.claims].map(([componentId, claim]) => ({ componentId, ...claim }));
    return [{
      kind: "room-state",
      transforms,
      claims,
      programRev: this.programRev,
      ...(this.program ? { program: this.program } : {}),
      // Nothing on the bench has been changed through the room since it started (or since the
      // last participant left): a reconnecting client's bench may seed it.
      fresh: this.state.size === 0,
      episode: this.episode,
      serverNow: this.now(),
    }];
  }

  /**
   * Handles one sanitized message from `participant` ({ id, name }).
   * @returns {{ sender: object[], others: object[], persist: { state?: Array<[string, object]>, program?: object } }}
   */
  handle(participant, message, { maxClaims = 16 } = {}) {
    const out = { sender: [], others: [], persist: {} };
    switch (message.kind) {
      case "claim": {
        const conflict = this.conflict(message.componentId, participant.id);
        if (conflict) {
          out.sender.push(this.claimMessage(conflict.resourceId, conflict));
          // With the room's state of the part, so a sender who already started moving it locally
          // goes back to what everyone else sees.
          const { componentId } = resourceParts(message.componentId);
          const { transform, rev } = this.authoritative(componentId);
          out.sender.push({ kind: "claim-denied", componentId: message.componentId, holderId: conflict.participantId, holderName: conflict.participantName, partId: componentId, transform, rev });
          return out;
        }
        const mine = [...this.claims.values()].filter((claim) => claim.participantId === participant.id).length;
        if (!this.claims.has(message.componentId) && mine >= maxClaims) {
          const { componentId } = resourceParts(message.componentId);
          const { transform, rev } = this.authoritative(componentId);
          out.sender.push({ kind: "claim-denied", componentId: message.componentId, holderId: "", holderName: "", partId: componentId, transform, rev });
          return out;
        }
        this.claims.set(message.componentId, { participantId: participant.id, participantName: participant.name });
        out.others.push(message);
        // The holder learns its claim stood, so its own claim/move traces follow the room.
        out.sender.push({ kind: "claim-granted", componentId: message.componentId });
        return out;
      }
      case "release": {
        const current = this.claims.get(message.componentId);
        if (current?.participantId !== participant.id) return out;
        this.claims.delete(message.componentId);
        out.others.push(message);
        return out;
      }
      case "transform": {
        const endpoint = message.transform.activeEndpoint;
        const resourceId = endpoint === 0 || endpoint === 1 ? `${message.componentId}::endpoint-${endpoint}` : message.componentId;
        // Only the holder moves a part: the sender must hold this resource (or, for a cable
        // end, the whole cable). Anything else gets the room's state back.
        const holds = this.claims.get(resourceId)?.participantId === participant.id ||
          (resourceId !== message.componentId && this.claims.get(message.componentId)?.participantId === participant.id);
        if (!holds) {
          const conflict = this.conflict(resourceId, participant.id);
          out.sender.push({ kind: "transform-rejected", ...this.authoritative(message.componentId), holderId: conflict?.participantId ?? "", holderName: conflict?.participantName ?? "" });
          return out;
        }
        if (this.jackTaken(message.componentId, message.transform, new Map())) {
          out.sender.push({ kind: "transform-rejected", ...this.authoritative(message.componentId), holderId: "", holderName: "", reason: "occupied" });
          return out;
        }
        const entry = this.store(message.componentId, message.transform);
        out.persist.state = [[message.componentId, entry]];
        out.others.push({ ...message, rev: entry.rev });
        out.sender.push({ kind: "rev-ack", componentId: message.componentId, rev: entry.rev });
        this.transmitterChanged([message.componentId], false, out);
        return out;
      }
      case "edit": {
        const refuse = (reason, extra = {}) => {
          out.sender.push({
            kind: "edit-result",
            opId: message.opId,
            ok: false,
            reason,
            current: message.changes.map((change) => this.authoritative(change.componentId)),
            programRev: this.programRev,
            ...extra,
          });
          return out;
        };
        for (const change of message.changes) {
          const conflict = this.conflict(change.componentId, participant.id);
          if (conflict) return refuse("held", { holderName: conflict.participantName, componentId: change.componentId });
        }
        for (const change of message.changes) {
          if (this.rev(change.componentId) !== change.expectRev) return refuse("stale", { componentId: change.componentId });
        }
        if (message.program && message.program.expectRev !== null && message.program.expectRev !== this.programRev) return refuse("stale", { componentId: "program" });
        // One plug per jack, judged on the state this whole batch would leave.
        const batch = new Map(message.changes.filter((change) => isSoundCable(change.componentId)).map((change) => [change.componentId, nextCableSockets(this.state.get(change.componentId)?.transform, change.transform)]));
        for (const change of message.changes) {
          if (this.jackTaken(change.componentId, change.transform, batch)) return refuse("occupied", { componentId: change.componentId });
        }
        const applied = message.changes.map((change) => {
          const entry = this.store(change.componentId, change.transform);
          return { componentId: change.componentId, transform: entry.transform, rev: entry.rev };
        });
        out.persist.state = applied.map((change) => [change.componentId, { transform: change.transform, rev: change.rev }]);
        let program;
        if (message.program) {
          this.programRev += 1;
          this.program = { program: message.program.program, running: message.program.running };
          program = { ...this.program, rev: this.programRev };
          out.persist.program = { program: this.program.program, programRunning: this.program.running, programRev: this.programRev };
        }
        out.others.push({ kind: "edit", participantId: participant.id, opId: message.opId, changes: applied, ...(program ? { program } : {}) });
        out.sender.push({ kind: "edit-result", opId: message.opId, ok: true, changes: applied.map(({ componentId, rev }) => ({ componentId, rev })), ...(program ? { programRev: program.rev } : {}) });
        this.transmitterChanged(applied.map((change) => change.componentId), Boolean(program), out);
        return out;
      }
      case "clock":
        // Clock sample for the shared transmission epoch: the client computes its offset from
        // the round trip (t0 is the client's send time, echoed back untouched).
        out.sender.push({ kind: "clock", t0: message.t0, serverNow: this.now() });
        return out;
      case "room-state-request":
        // A client whose seed was refused (or that lost track) asks for the room's state again.
        out.sender.push(...this.join());
        return out;
      case "program": {
        this.programRev += 1;
        this.program = { program: message.program, running: message.running };
        out.persist.program = { program: message.program, programRunning: message.running, programRev: this.programRev };
        out.others.push({ ...message, programRev: this.programRev });
        out.sender.push({ kind: "program-ack", programRev: this.programRev });
        this.transmitterChanged([], true, out);
        return out;
      }
      case "episode": {
        const actor = { id: participant.id, name: participant.name };
        const result = reduceRescue(this.episode, message.action, actor, this.now(), (id) => this.state.get(id)?.transform ?? null);
        if (!result.ok) {
          out.sender.push({ kind: "episode-result", opId: message.opId, ok: false, reason: result.reason });
          out.sender.push(this.episodeMessage());
          return out;
        }
        this.episode = result.state;
        out.persist.episode = this.episode;
        let program;
        if (result.program) {
          // A transmission sends the program it runs: it becomes the room's program, stopped
          // (the transmission, not an endless loop(), drives the pins).
          this.programRev += 1;
          this.program = { program: result.program.program, running: false };
          program = this.program;
          out.persist.program = { program: this.program.program, programRunning: false, programRev: this.programRev };
        }
        const update = this.episodeMessage(program);
        out.sender.push(update);
        out.sender.push({ kind: "episode-result", opId: message.opId, ok: true });
        out.others.push(update);
        return out;
      }
      default:
        out.others.push(message);
        return out;
    }
  }

  /** A participant left: release everything they held. Returns messages for everyone else. */
  leave(participant) {
    const released = [];
    for (const [resourceId, claim] of this.claims) {
      if (claim.participantId !== participant.id) continue;
      this.claims.delete(resourceId);
      released.push({ kind: "release", participantId: participant.id, participantName: participant.name, componentId: resourceId });
    }
    const episode = onParticipantLeft(this.episode, participant.id);
    if (episode) {
      this.episode = episode;
      released.push(this.episodeMessage());
    }
    return released;
  }

  /**
   * Everyone left: the bench returns to its default state (as before this protocol). The
   * episode keeps its design and rounds; roles are freed and a running transmission ends.
   */
  reset() {
    this.claims.clear();
    this.state.clear();
    const episode = onRoomEmpty(this.episode, this.now());
    if (episode) this.episode = episode;
  }

  /**
   * Whether storing `transform` would put a second plug into a jack (sound patch cables only),
   * judged on the cable's merged sockets (a cable-end move keeps the room's other end), so two
   * people each moving one end of the same cable into the same jack are refused.
   */
  jackTaken(componentId, transform, batch) {
    if (!isSoundCable(componentId)) return false;
    const sockets = batch.get(componentId) ?? nextCableSockets(this.state.get(componentId)?.transform, transform);
    const socketsOf = (id) => (batch.has(id) ? batch.get(id) : this.state.get(id)?.transform.sockets ?? null);
    return soundJackConflict(componentId, sockets, socketsOf) !== null;
  }

  store(componentId, transform) {
    const previous = this.state.get(componentId);
    let next = { ...transform };
    const end = transform.activeEndpoint;
    if ((end === 0 || end === 1) && previous) {
      // A cable-end move changes only that end, the one the sender holds: two people may each
      // hold one end, and each sender's view of the other end can be behind. The room's other
      // end is always kept, whatever the message says about it (the claim covers one end only).
      const base = previous.transform;
      const sockets = Array.isArray(base.sockets) ? [base.sockets[0], base.sockets[1]] : [null, null];
      sockets[end] = transform.sockets?.[end] ?? null;
      next = { ...base, sockets: sockets.some((socket) => socket !== null) ? sockets : null };
      if (base.endpoints) {
        const endpoints = [base.endpoints[0], base.endpoints[1]];
        if (transform.endpoints) endpoints[end] = transform.endpoints[end];
        next.endpoints = endpoints;
      } else if (transform.endpoints) next.endpoints = transform.endpoints;
    }
    delete next.activeEndpoint;
    // Live drags omit electrical values and switch state (they never change them): keep the accepted ones.
    if (next.props === undefined && previous?.transform.props !== undefined) next.props = previous.transform.props;
    // Likewise the slide-switch state: moves never carry it, and an edit without it keeps it.
    if (next.on === undefined && previous?.transform.on !== undefined) next.on = previous.transform.on;
    const entry = { transform: next, rev: (previous?.rev ?? 0) + 1 };
    this.state.set(componentId, entry);
    return entry;
  }
}
