/** Exclusive, reversible ownership of explicitly selected passive pending evidence. No semantic decisions. */
import { threadKey } from './model.ts'
import { EnginePart } from './part.ts'

export interface HeldInput { triggerId: string; thread: string; queuedAt: string }
/** Core ownership changes run inside Engine transactions; app receipts share that same repository transaction. */
export class TriageHandoffs extends EnginePart {
  preview(ids: string[]) {
    if (!ids.length || ids.length > 200 || new Set(ids).size !== ids.length) throw new Error('Choose 1..200 distinct trigger IDs')
    const referenced = new Set(this.repo.tickets.referencingTriggers(ids))
    const active = this.repo.threads.active()
    return ids.map(triggerId => {
      const trigger = this.repo.triggers.get(triggerId)
      const thread = trigger?.threads[0] && this.repo.threads.get(threadKey(trigger.threads[0]))
      let reason = ''
      const disposition = this.repo.triggers.disposition(triggerId)
      if (!trigger || !thread) reason = 'missing'
      else if (disposition?.triage) reason = 'held'
      else if (trigger.addressed) reason = 'addressed'
      else if (!thread.pending.includes(triggerId)) reason = 'not_pending'
      else if (active.some(item => item.evaluating?.triggerIds.includes(triggerId))) reason = 'active_eval'
      else if (disposition?.decisionId || this.repo.decisions.byThread(thread.key).some(item => item.triggerIds.includes(triggerId))) reason = 'prior_decision'
      else if (!disposition || disposition.filtered || disposition.evalId || disposition.fanout.length || disposition.context?.length
        || disposition.handbacks?.length || disposition.acked?.length || referenced.has(triggerId)) reason = 'prior_owner'
      else if (trigger.threads.some(ref => {
        const related = this.repo.threads.get(threadKey(ref))
        return related?.subscriptions.length || related?.context?.length || related?.correlated.some(key => {
          const correlated = this.repo.threads.get(key)
          return correlated?.subscriptions.length || correlated?.context?.length
        })
      })) reason = 'subscribed'
      else {
        const gate = this.policy().gate(trigger, thread, [])
        if (!gate.admissible || gate.strength !== 'inferred') reason = 'not_passive_inferred'
      }
      return { triggerId, eligible: !reason, reason: reason || 'eligible',
        thread: thread?.key ?? '', queuedAt: thread?.evalQueuedAt ?? thread?.createdAt ?? '' }
    })
  }
  private validateOwner(owner: string, generation: number): void {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(owner) || !Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid handoff owner or generation')
  }
  hold(ids: string[], owner: string, generation: number): HeldInput[] {
    this.validateOwner(owner, generation)
    const preview = this.preview(ids)
    if (preview.some(item => !item.eligible)) throw new Error('Handoff refused: selection is not entirely eligible')
    const inputs = preview.map(({ triggerId, thread, queuedAt }) => ({ triggerId, thread, queuedAt }))
    for (const input of inputs) {
      const disposition = this.repo.triggers.disposition(input.triggerId)!
      this.repo.triggers.saveDisposition(input.triggerId, { ...disposition, triage: { owner, generation, heldAt: this.now() } })
      const thread = this.repo.threads.get(input.thread)!
      thread.pending = thread.pending.filter(id => id !== input.triggerId)
      if (!thread.pending.length) delete thread.evalQueuedAt
      this.repo.threads.save(thread)
    }
    return inputs
  }
  release(inputs: HeldInput[], owner: string, generation: number): void {
    this.validateOwner(owner, generation)
    if (!inputs.length || inputs.length > 200 || new Set(inputs.map(input => input.triggerId)).size !== inputs.length) throw new Error('Choose 1..200 distinct held inputs')
    // Validate every owner before any mutation; no partial release or ownership theft.
    for (const input of inputs) {
      const held = this.repo.triggers.disposition(input.triggerId)?.triage
      if (held?.phase) throw new Error('Production-owned evidence requires production rollback; completed judgments remain fenced')
      if (!held || held.owner !== owner || held.generation !== generation) throw new Error('Handoff owner or generation changed')
      const trigger = this.repo.triggers.get(input.triggerId)
      if (!trigger?.threads[0] || !this.repo.threads.get(input.thread)) throw new Error('Held evidence missing')
      if (threadKey(trigger.threads[0]) !== input.thread || !Number.isFinite(Date.parse(input.queuedAt))) throw new Error('Held input identity or queue age invalid')
      if (this.repo.threads.active().some(thread => thread.evaluating?.triggerIds.includes(input.triggerId))) throw new Error('Held evidence has conflicting active Eval')
      if (this.repo.triggers.disposition(input.triggerId)?.decisionId) throw new Error('Held evidence already decided')
      if (this.repo.decisions.byThread(input.thread).some(item => item.triggerIds.includes(input.triggerId))) throw new Error('Held evidence already decided')
    }
    for (const input of inputs) {
      const disposition = this.repo.triggers.disposition(input.triggerId)!
      const { triage: _held, ...rest } = disposition
      this.repo.triggers.saveDisposition(input.triggerId, rest)
      const thread = this.repo.threads.get(input.thread)!
      const otherAge = thread.pending.length ? thread.evalQueuedAt ?? thread.createdAt : input.queuedAt
      if (!thread.pending.includes(input.triggerId)) thread.pending.push(input.triggerId)
      thread.evalQueuedAt = [otherAge, input.queuedAt].sort()[0]!
      this.repo.threads.save(thread)
    }
  }
}
