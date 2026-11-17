# Changelog

## 0.9.0 — 2026-11-17

- Replace periodic global orchestration with committed lifecycle changes, per-judgment deadlines and durable Effects. Completed intake recovery epochs keep their cursor instead of repeatedly rescanning history.
- Run authorized business follow-ups through native DSH Schedule. Retain Ticket identity, wait version and cancellation receipts; reject late or duplicate reminders before resuming the worker.
- Load current work independently of historical diagnostics. Use authenticated change subscriptions, native Connection resets and terminal-stream recovery instead of periodic page reads; preserve drafts through reconnects.
- Isolate historical statistics, Line views and audit/provenance computations in read-only workers observed through native DSH Jobs. Bound workers by view kind, keep source access with the live Source owner, and reject results across permission changes.
- Verify the separately built worker outside the host loader in both platform build gates. Index recent deliveries and active judgment sets in the canonical database.
- Retain task-reassignment evidence through provider fallback and partial reconciliation, without treating missing records as confirmed removal.

Upgrade note: database format increases from 15 to 16. Back up state and configuration before activation. Old readers reject format 16; code-only downgrade is unsupported. On an incompatible activation failure, retain current data and the stop/pause state for explicit recovery instead of overwriting newer records with an old snapshot. Source scope and business execution permissions are unchanged.

## 0.8.3 — 2026-11-17

- Keep a current-turn original owner instruction actionable after a worker report, while refusing to borrow an earlier owner's instruction in a new background turn. Exact latest-owner quotes, corrections, managed-session and receipt checks remain.
- Identify owner/latest input sequence, timestamp and source kind in refusals without copying private message text. Workbench status lists delegation receipts, not all discussion messages.

Upgrade note: no schema, source scope or execution-permission change from 0.8.2.

## 0.8.2 — 2026-11-17

- Restore the stable Main entry when the native Session catalog becomes ready or its target arrives after an initial navigation error. Ignore superseded navigation failures without adding a retry timer or another catalog.
- Keep historical-view archival independent of later Main rotation and retirement. The existing unconsumed handoff payload remains the rotation barrier; later reminders and archives can settle while an old draft stays open.

Upgrade note: no state schema change from 0.8.0/0.8.1. Existing schema 15 backup/downgrade precautions remain unchanged.

## 0.8.1 — 2026-11-17

- Keep the first composer editable in a completely quiet Main segment by reusing one canonical native Workspace at Main cwd. Preserve the pinned global entry, existing Workspace title/other sessions and worker-local directories; no per-segment Workspace or warm-up model turn.

Upgrade note: no schema change from 0.8.0. Schema 15 downgrade precautions still apply to upgrades from 0.7.x.

## 0.8.0 — 2026-11-17

- Keep the logical Main entry stable while rotating idle native sessions after 20,000 records, preserving model selection, owner context, worker/Ticket identity and native reminder targets.
- Persist quiescent-window inputs and handoff context through existing Effects and native inboxes. Recover interrupted claims, preserve source attribution, and reject retries already consumed in any original segment.
- Separate non-waking background context from ordered owner forwarding so passive notices cannot strand the input that wakes their consumption.
- Retain native composer, inline task and turn-tail reply drafts during handoff; cancel pending automatic navigation when editing resumes. Open native views delay archival without copying editor contents.
- Read previous Main indexes and original entries on demand through owner-only historical resources.
- Serve the conversation dock a bounded projection and acknowledge saved pause changes without waiting for Main notice delivery.

Upgrade note: Store schema 14 advances to 15 to exclude older readers without the new effect handlers. Existing business records and native histories are retained. Code-only downgrade is unsupported; inspect post-upgrade work and use a matching backup. Requires DSH 0.2.2-rc.1-compatible hosts. A handoff above 1 MB waits for native compaction instead of truncating context.

## 0.7.2 — 2026-11-16

- Run production information judgments in native owned batch sessions, with six batch-bound tools, pause admission, current-generation checks and automatic handle release. Routine classifications no longer enter the owner's Main history.
- Resume consumed-but-unfinished judgments after a host restart through one idempotent continuation, preserving the original receipt and deadline. Handoff to Main carries permission-checked receipt references, with no copied protected summaries.
- Read live owner evidence and workbench status without cloning the full Session journal; retain exact owner quote and source validation.
- Keep runtime repair readiness independent of provider transport health, while retaining setup, identity and drain checks.
- Remove private CI dependency-cache hooks that stalled jobs, and use the runner service's network route.

## 0.7.1 — 2026-11-16

- Restore Session Query access in the Main Session's scoped workbench tool after the DSH 0.2.2 upgrade.
- Keep original owner instructions actionable after runtime/time snapshots, preserving exact quotes, newer-owner precedence, background authority rejection and retry deduplication.
- Ground configuration and latency diagnoses in live settings and the active Session/provider, while keeping the router prompt within its existing context budget.

## 0.7.0 — 2026-11-16

- Require DSH 0.2.2-rc.1-compatible hosts, Cordis 4.1, Schemastery 3.19 and Node >=24.9. Upgrade the host and bundle as a pair; retain 0.6.8/0.2.1-rc.3 together for rollback.
- Read original discussion/transcript evidence through live-preferred Session Query observations, preserving cancellation and releasing leases without starting an Agent.
- Dispatch WeChat service calls through native tool batches and validate the returned call identity before accepting source evidence.
- Follow the host's writable/status configuration contract and reject unbound-port management requests.
- Select side-by-side hosts during controlled activation, back up stopped-host Session/config/memory data with Windows long-path support, and restore the original host path/bundle on failure without overwriting new business records.
- Download Windows CI npm packages directly while retaining GitHub's existing route. Public prerequisites follow the selected source's Node requirement.

## 0.6.8 — 2026-11-16

- Pin Main quote replies to the selected source message, preserving the editor, focus and draft when newer Turns arrive.
- Offer historical Turn reply buttons and separate drafts per message; failed sends retain the original draft, while successful sends return to the latest Turn.
- Send native source identities with bounded visible-text quotes through the existing Session input. Quotes exclude reasoning, preserve the beginning and closing question when truncated, and do not add business authorization.
- Keep polling confined to the active editor; existing Tickets, Question identities and Store schema are unchanged.

## 0.6.7 — 2026-11-15

- Forward an installed native memory plugin's ordinary read/write/search, curation and history tools into managed DSH Session scopes, preserving the provider's implementation and output contracts.
- Keep unrelated tools and memory import/export/AGENTS synchronization outside the bridge. Removed or replaced providers cannot execute through stale bindings; Ticket guards continue to apply.
- Treat retrieved memories as context while current facts, requests and Policy retain authority.

Upgrade note: the memory plugin remains an optional profile dependency. Install a compatible pinned bundle before Superagent and restart the profile. Memory storage, automatic extraction and injection stay with that plugin; this release creates no separate memory database and performs no Codex import.

## 0.6.6 — 2026-11-15

- Allow an owner-managed workbench to select an explicit proxy bypass for credential acquisition, startup dependencies and its model process. Direct executor commands also bypass OS proxy fallback, including Python on Windows.
- Keep explicit executor proxy routing available independently of the desktop's Codex/system proxy settings. Existing owner launchers inherit their prior behavior when noProxy is omitted.
- Let router-preset network commands use timeout ceilings without treating them as waiting; preserve standard-preset and explicit sleep/job-wait boundaries with clearer refusal messages.

Upgrade note: no database or source-scope change. Direct connectivity is selected in private launcher configuration; external event wrappers must retain that route. The private Feishu wrapper's system-proxy inheritance requires its separate configuration update.

## 0.6.5 — 2026-11-14

- Let a new assessment wake an idle Main Session when only Superagent's injected notices are pending. Keep those notices intact for the next step, and preserve owner/relay priority, durable-consumption checks and bounded assessment admission.

Upgrade note: no state-schema, source scope or authorization change. This fixes an idle-notice deadlock found during 0.6.4 live backlog recovery; accepting a recovery request still does not claim a completed judgment or business action.

## 0.6.4 — 2026-11-14

- Add bounded operator recovery through the existing management API and information-follow-up view, preserving generation, ownership and source checks.
- Keep intake recovery available before the first production receipt; identify and retain unavailable owners while recovering eligible groups.
- Allow blocked judgments to revalidate current source configuration without revealing redacted receipt content. Distinguish request acceptance from completed judgment or business action.
- Wait for startup synchronization and follow-up reconciliation before closing the Store during shutdown or activation.

Upgrade note: no database schema or source-permission change. Retained evidence is not cleared or automatically classified. Operators request bounded recovery; workers continue within existing mandates.

## 0.6.3 — 2026-11-14

- Accept original owner quotes within delegated tasks, share one confirmation across distinct goals, and append missing goals without replacing existing task identities or retry receipts.
- Preserve the selected goal in source evidence and require actual continuation receipts before claiming a supplement reached an existing Ticket.
- Return current triage bindings with context pages and explain stale-reference recovery while retaining evidence/version checks.
- Treat WeChat connection closure as a retryable context-read failure; permission failures remain terminal.
- Check prior stop decisions, source coverage and owner-local event times before presenting follow-up requests.

Upgrade note: no state-schema or permission changes. The separate WeChat package's nonblocking MCP waits require its own deployment; this release alone does not activate that dependency or erase historical triage blocks.

## 0.6.2 — 2026-11-13

- Refresh the README architecture using the approved information-input / Superagent coordination / task-execution layout, with an explicit owner entry and adjustable focus domains.
- Retain the editable HTML alongside the SVG and export these architecture assets from the development source so public snapshots cannot keep a stale diagram.

Documentation release: no runtime behavior, state schema, permission or instance activation change.

## 0.6.1 — 2026-11-13

- Keep installation readiness separate from resource catch-up and provider incidents. Activation verifies the owned runtime build/setup and records Source health states without requiring every reader to finish or recover before the upgrade can complete.
- Verify the actual runtime after a launcher command error, including rollback. Keep the command operation and exit code without copying its arguments or output; restore the original dispatch state when the previous runtime is demonstrably available.

Upgrade note: 0.6.0 was retained as a private tagged candidate after daily-instance acceptance exposed an overly broad Source-health gate. 0.6.1 is the intended public release of the architecture closeout. The personal-account migration and Store schema 14 contract below remain unchanged; a recorded Source incident is not claimed resolved by a successful installation.

## 0.6.0 — 2026-11-13

- Give the personal Feishu account and application event connection one native Cordis owner. Resource Sources keep their own subscriptions, durable progress and delivery counters; account reload joins the previous connection before starting another.
- Request incremental catch-up when initial subscriptions succeed or recover, without turning unchanged idle checks into repeated resource reads. Preserve bot identity separately from the normal user default.
- Isolate watched-document reads, delivery, acknowledgment and subscriptions so one inaccessible object does not block healthy objects or erase newer notifications.
- Distinguish ordinary held evidence from blocked triage. Retain sanitized event failure stages, provider/system codes and delivery references without copying business bodies or credentials into health.
- Resolve the mailbox `me` alias to the verified owner's primary address; retain auditable recovery of provably foreign or missing queued messages. Compare recurring calendar changes independently of a moving planning window.
- Version Windows owner activation, maintenance drain, consistent backups, artifact/startup verification and code/configuration rollback. Preserve new business records on rollback, retain stop intent for incompatible schema recovery, and route the supervisor through the configured verified launcher.

Upgrade note: personal activity/workspace profiles must move their duplicated account fields into `dsh-superagent-lark-account` using the offline migration helper in `INSTALL.md`. Bot-only profiles keep the CLI path. Store schema remains 14; existing tickets, source checkpoints and permissions are retained. Point older scheduled supervisors to this release's `owner-supervisor.ps1` once; subsequent activations follow `launcherPath` in the private configuration.

## 0.5.38 — 2026-11-13

- Register chat recovery identity at the common Feishu receive boundary, so shared SDK events preserve new direct-chat backfill and thread polling just like the original CLI consumer.
- On shared-transport startup or reconnect, request bounded catch-up from the existing task, mail, calendar and watched-document checkpoints. A newer reconnect request survives an in-flight read; steady idle rounds remain API-free.
- Preserve an existing polling calendar baseline when adopting native synchronization, so changes during the switch remain visible.

Upgrade note: no Source configuration or Store schema changes beyond 0.5.37. This patch is the intended public version of the personal event-intake rollout.

## 0.5.37 — 2026-11-13

- Share one brokered official Feishu SDK connection across bot IM and user task, incoming-mail, primary-calendar and watched-document notifications (#251, #256).
- Persist notifications before acknowledgment, coalesce object reads, retain failed reads independently and avoid resource API calls in idle event-mode rounds.
- Recover calendar changes through native sync tokens, retain explicit expiry gaps and cancellation tombstones, and report rescheduling without inventing cancellation.
- Keep personal-message recovery independent of bot membership and filtered bot records. Reconcile important documents only within the configured watch list.
- Wake WeChat through its owning package's Windows database notifications, preserving validated incremental reads and ACK, with a separate reconciliation interval.
- Let the owner launcher keep user identity as the host default while isolating the bot channel configuration.

Upgrade note: existing configurations retain polling defaults. Store schema and business records remain compatible. After enabling event mode, rollback restores the affected Source settings as well as the prior package. Personal IM still uses bounded user backfill where native push is unavailable; received-mail push does not cover mailbox moves or deletions.

## 0.5.36 — 2026-11-13

- Lead the personal workspace with work lines and open their shared detail from global search.
- Keep unsent replies bound to their Ticket and Question, refresh selected information-history pages independently, and provide an explicit close action for failed or blocked work.
- Query retained unresolved information with source-provided identity and event time. Read exact receipt references through the main conversation, using stable text snapshots with source-access and generation checks on every page.
- Verify configured dependency consumers before activation stops the current service and before a fresh startup. Retire obsolete delivery and stage effects for ended paused Tickets.
- Supply the isolated Linux CI job with its repository-configured HTTPS route.

Upgrade note: this release supports the existing Store format, persistent Tickets, work lines, Source checkpoints and session records. Deployment and usability receipts are tracked on #231 and #133.

## 0.5.35 — 2026-11-12

- Carry production triage read receipts across context re-collection and generation retries when the collected content is unchanged. A receipt records the collecting generation and a content signature, an identical re-collected manifest keeps its page offset and completion, a changed signature drops the stale receipt, and re-reading a fully read context from offset zero keeps it complete (#215).
- Restore usable Linux validation on the dedicated Redmi runner by building the 500-receipt scalability fixture inside the existing Store transaction. The receipt graph, read-count limits, permission revocation checks and timeout stay unchanged (#216, #218).

Upgrade note: no database or source-scope migration. The triage change affects retry bookkeeping only; the CI change is test fixture setup and runner documentation. Existing Tickets, Sources, follow-up checks and recorded receipts stay readable.

## 0.5.34 — 2026-11-12

- Yield between durable effect dispatches so a large retry backlog cannot starve HTTP requests and timers when retry delays expire during synchronous queue processing. Queued records and per-kind concurrency limits remain unchanged.

## 0.5.33 — 2026-11-11

- Respect external execution claims on originating and bound GitHub objects, retain notification-only requests for later handoff, and adopt existing owned PRs without renaming their branches.
- Retry transient IM reads and consumed judgment timeouts at most twice through durable Effects. Fit native context to each batch budget, preserve source gaps, and permit bounded judgments from readable partial evidence.
- Keep source access, identity, policy and prompt checks while preventing unrelated settings changes from invalidating information triage.
- Associate judged source evidence with existing Tickets and work lines through normal tools. Show linked evidence on demand and recheck source access on every read.
- Publish public snapshots only after candidate build, Windows and provenance checks pass, with resumable promotion of the same prepared artifact.

Upgrade note: no database migration or automatic reopening of completed judgments. Retained technical failures can be explicitly retried; permission failures and missing evidence remain visible. External takeover requires stopping active work before setting the claim label.

## 0.5.32 — 2026-11-11

- Expose source-observed conversation labels, event time, sender metadata and reply references in production IM triage without changing native evidence identities or retained batch bindings.
- Preserve native Feishu sender type/ID namespace, message kind and parent reference and WeChat message kind during subsequent collection. Existing records retain available facts and explicit gaps.
- Supply identity lookup and object-based operational reading guidance only when an IM production judgment is requested, reusing current Skills, native readers and matter receipts.

Upgrade note: no database or source-scope migration. Existing batches expose their retained message headers on read. Historical missing names and sender types remain unknown until supported by native evidence.

## 0.5.31 — 2026-11-11

- Keep prior-matter candidate, context warning and detail projections valid for native tool JSON transport. Missing optional evidence and source-redacted private fields are omitted, preserving explicit values and permission checks.
- Preserve native WeChat incoming/outgoing direction through activity, bounded contexts and legacy assessment projections, including unknown senders, without deriving sender authority or changing historical identities.

Upgrade note: no additional schema change. Existing production batches can be reread after upgrade; native direction evidence is available on subsequent reads and new collection.

## 0.5.30 — 2026-11-11

- Return lossless production-triage tool metadata when a context anchor is missing, allowing the coordinator to read its binding and submit a truthful unknown judgment. Explicit content mismatch values remain represented.

Upgrade note: no additional migration. Awaiting batches can continue using the existing read/context/submit tools after upgrade.

## 0.5.29 — 2026-11-11

- Share the existing 200-message context budget across production batch inputs to keep repeated history reads within the whole-batch deadline. Feishu context prioritizes recent replies, preserves independent anchor checks and reports budget truncation explicitly.

Upgrade note: no additional state migration. Existing blocked context reads can use production retry to refresh their bounded contexts.

## 0.5.28 — 2026-11-11

- Keep a pending reply bound to its original editor target in Today and My work. Reading another Ticket remains available while a reply settles, and a delayed success or failure cannot clear or replace another draft.

Upgrade note: no database or configuration migration beyond 0.5.27.

## 0.5.27 — 2026-11-11

- Compare fetched IM content with the Source-native collected text so Activity presentation wrappers do not mark unchanged messages as edited or force unknown judgments.
- Read WeChat IM context for millisecond production windows using the equivalent whole-second native timestamp range. Validate native ISO time boundaries and preserve the original requested window, account, conversation, pagination and snapshot checks.

Upgrade note: no additional schema change beyond 0.5.26. Existing blocked WeChat production batches can use the normal explicit retry path to refresh context and continue judgment.

## 0.5.26 — 2026-11-11

- Add opt-in automatic IM intake with bounded conversation batches, exact per-message judgment coverage, native context reads and recoverable historical pending handoff. The coordinator records grouped information and action suggestions, with revision-guarded cross-batch matter continuity and a workbench view.
- Preserve incomplete DSH workspace preparation across retries and restart so partial files cannot silently become a ready worker workspace.
- Show unknown automation state when the current Host Schedule catalog is unavailable, and restore the actual state after successful reads.

Upgrade note: the database migrates to schema 14. Back up state before activation and restore the matching database when rolling back to an older binary. Automatic intake requires triageHandoff, triageProduction and triageAutomatic; triageHistorical enables bounded capture of eligible legacy pending evidence. These flags default off. Judgment suggestions retain existing business authorization boundaries.

## 0.5.25 — 2026-11-10

- Give Today's decision cards a clear reading order: the question, recommended action, evidence and risk are separated, task metadata and controls use readable sizes, a long draft stays keyboard-scrollable, and the Today grid follows the content width instead of the window.
- On a Ticket page, place the pending question and a halted Ticket's reason directly under the status line, before follow-up, results, management and history, and use host colour tokens with 44px coarse-pointer targets.
- Keep a submitted confirmation dialog open until its action settles: the confirm control is disabled while it runs, every close path waits, and a failure keeps the dialog for a retry.
- Bring an opened deliverable preview into view, focus the preview block, and return focus to the original result button when it closes.
- Hold a follow-up check while its migration intent or a pending cleanup exists, serialize adoption and an explicit retry on the same request, and never treat a task awaiting deletion as a valid migration result.
- Bound undecided Evals at four in flight, three per explicit or inferred channel with one slot reserved for the other channel. Waiting evidence keeps its durable enqueue time, newer evidence does not refresh that age, and a retry goes to the back of the queue.
- Bound unread candidate notices to one and acknowledge a consumed notice before the unread-inbox guard. Prune only stale plugin candidate notices, build the card only when delivery can proceed, and start the evaluation timeout when the candidate is consumed.

Upgrade note: no state migration. Deferrals, the management queue, work lines and follow-up records stay readable; activation replaces the running build and keeps the paused-backlog behaviour.

## 0.5.24 — 2026-11-10

- Project deferred Questions from one deferral record. A deferred Question leaves the immediate person list and count, appears in a separate deferred group with its return time, returns once when due, and keeps its early answer control. A replaced Question does not inherit the old deferral.
- Keep a Ticket's management draft across polls. The editor follows the Ticket, per-field drafts preserve local edits, unedited fields follow the server, same-field conflicts keep base, local and remote values, a save sends only edited fields, and a failed or ended save keeps the values visible.
- Label stale workbench state with the last successful refresh, keep a refused queue action's reason and form, show reply failures in the visible panel, and require an explicit discard for non-empty supplement text.
- Keep draft discard and queue errors safe while another action is running.
- Refuse worker reports from a replaced assignment in the shared report path, so a stale write cannot claim a PR, relay or end the Ticket.
- Keep one Host Schedule task per migrated follow-up when migrations run concurrently, and retain failed compensation deletes for a later retry.
- Let development and review Tickets read work lines and unlinked Tickets as bounded context resources.

Upgrade note: no state migration. Deferrals stay in the Source's existing records and management drafts are client state; activation replaces the running build.

## 0.5.23 — 2026-11-10

- Keep the workbench user identity as the default while isolating the Feishu message channel in its own bot-only CLI configuration. Activation checks the same bot binding before stopping the service.

Upgrade note: existing state stays readable. Configure an existing bot-only directory using the Feishu Source or the Windows launcher bootstrap setting; the host user configuration stays unchanged.

## 0.5.22 — 2026-11-10

- Show possible work lines on the candidate card and in the assessment context. Up to five lines are recalled from the message's own words, each with the matched terms, its last update, its most recently changed open Ticket, up to three recent Tickets with a short report preview, and a read pointer. A fixed note states that recall is evidence for the main Session's membership judgement, not an attachment or a verdict; no recall omits the field.
- Let activation keep a durable queued backlog while dispatch is explicitly paused, so a planned drain no longer blocks a version switch. The preflight still refuses active workers and an unpaused queue.
- Reuse the verified startup snapshot from the shutdown bridge instead of a second cold HTTP probe, and read management endpoints with a 15-second timeout.

Upgrade note: no state migration. The candidate card grows one optional field; existing Tickets, lines, Sources and follow-up checks stay unchanged. Activation replaces the launcher with the paused-backlog-aware build.

## 0.5.21 — 2026-11-09

- Let the coordinator decide goal identity from context. Same-titled goals stay independent; only a retry of the same native DSH call or accepted Ticket reuses line creation, and a routing retry preserves later owner corrections.
- Correct a mistaken line membership from the coordinator or the workbench's inline **调整归属** form. Moves commit both line records atomically; detach keeps the Ticket intact. History retains the actor, reason and source/destination, including a later reattachment with the same evidence.
- Read the owner's recent main discussion through the existing executor resource, with a bounded 24-hour window and attachment references for workbench improvement candidates. External drafts keep each claim and question bound to its source.
- Check the actual bot identity and effective profile in the same startup environment before activation stops a healthy workbench; keep the existing prompt budgets while tightening repeated wording.
- Answer in place instead of retyping in the composer: a Ticket card that carries a Question offers a one-line reply on the card, and the newest completed Turn of the main conversation offers one under its closing text. Enter sends the exact Question answer or a message to the same main Session; a failed send keeps the line for a retry, and other Sessions keep the composer alone.

Upgrade note: existing line ids and Ticket state stay readable without migration. No business memberships, Sources, follow-up checks or scheduled summaries are changed automatically.

## 0.5.20 — 2026-11-09

- Add work lines for goal continuity: the owner desk lists open lines with their active Ticket, latest result and next check; line detail keeps every stage and the recorded link judgement; closed lines stay folded and refuse new work until an explicit restore. Routing and assessment record what evidence matched before continuing a goal.
- Show the next automatic runs: every pending Ticket check carries its next time, latest report and actual blocker, and a mechanical check can move once to a DSH Host Schedule task with an idempotent intent, crash reconciliation and cleanup.
- Carry the method and required skills a ready report used into the next Session, and validate required skills per routing item.
- Show the running build's version, source commit and build time, and warn only when a source observation made after the build moved ahead; keep private-repository CI on hosted runners unless self-hosted labels are configured.

Upgrade note: the work-line and follow-up views are new workbench read models and need no state migration. Follow-up checks stay on their Ticket until the owner explicitly migrates one; a migrated check becomes a one-off Host Schedule task.

## 0.5.19 — 2026-11-09

- Turn Today into the owner's decision queue: one row per pending Question, with optional recommendation, reason, risk and draft; accept, revise, defer to a due time, or mark "no action needed" with a reversible record. Keep stalled Tickets without a Question visible as recovery work, and remove the automatic daily focus replay.
- Start "My work" collapsed and remember whether the owner desk and its follow-up agenda are open. Cap the expanded desk and give its body an inner scroll, so a long agenda no longer covers the conversation. Scope the row-wide click overlay to list rows, so a section handle can no longer open a Ticket.
- Fix the flaky paused-connection executor test by synchronizing on its blocked thread start.
- Install from one `enyagentdesk.install.json` and one command: the installer creates the profile, saves both the GitHub and Feishu Sources with their allowed lists and executor limits, and runs a self-check. `INSTALL.md` now carries the agent-facing path and its limits.

Upgrade note: the queue is a new workbench read model and needs no state migration. Its actions answer only the exact current Question; deferred and ignored records stay with the Source.

## 0.5.18 — 2026-11-08

- Acquire the state-directory lock before registering the runtime service. A fresh lock left by the preceding process no longer poisons same-context startup retries with a duplicate service; refused service registration also releases its acquired lock.

## 0.5.17 — 2026-11-08

- Keep the digest's identity metadata query free of unsupported identity-selection flags. Continue binding its existing authorized user configuration and selecting the user explicitly for calendar, mail and delivery operations.

## 0.5.16 — 2026-11-08

- Process owner answers in a distinct Codex turn and record reading before its tool report, while retaining protection against an older turn's result.
- Advance the daily mail delivery checkpoint only after a confirmed send, so failed sends and read-only previews retain mail for a retry. Keep the existing same-day delivery receipt.

## 0.5.15 — 2026-11-08

- Save owner answers transactionally against the exact pending question. Distinguish saved, delivered, read and reported states; preserve stale-question drafts and prevent duplicate delivery.
- Show all pending Ticket checks in a shared time-ordered view, including due status and actual scheduler blockers. Unify reply and task actions across native owner entrypoints.
- Fix clipped task rows, Settings scroll restoration, required answer wording and precise cancellation confirmation.
- Surface invalid Source configuration and repair its original JSON with revision protection while retaining pending replies.
- Restore the Source delivery dependency boundary and check the existing module layers automatically.
- Maintain the existing daily calendar/mail summary with explicit user binding, current email triage, coverage diagnostics and checkpoint protection. It remains separate from continuous Sources.
- Install into the existing profile store with success/failure receipts, and clarify source installation and first use.

- Check every public-export scan match, restrict synthetic ID exceptions to tests, and redact matched values from failures.
- Continue public history without force-pushes. Bind each export to its immutable main release tag and prepare a checked package plus source/commit/hash receipt before publishing the public branch and tag atomically.
- Adopt the main/develop branch and release model. Public snapshots are exported from `main` and mirrored to `EnyAgentDesk`; external changes are implemented here first.

Upgrade note: new owner-answer Inputs require this bundle to process them. Preserve state and reconcile pending answers before a rollback. Profile installation, daily-summary adoption, public release and runtime activation remain separate operations. Existing v0.5.14 tags and assets are not replaced.

## 0.5.14

- Explain unavailable discussion, answer and update actions while the main Session is not ready; preserve draft input.
- Enable the native workbench in the personal profile example and provide an owner setup client that preserves unrelated settings and refuses a different owner.
- Compact repeated role, dispatch and communication instructions while retaining the original model-context budgets, authorization and review limits.
- Align regressions with queued main-Session delivery, optional GitHub setup, current Source fields and responsive CSS conventions.
- Pin reviewed security updates for Zod, Vite, source-map-js and both undici major lines. Installation lifecycle scripts remain disabled.
- Package source scripts without local Python bytecode or cache paths.
- Run the complete Linux suite and a Windows native suite in CI, including owner setup and Windows launcher checks.

Mail, calendar, task and approval collection are not built-in continuous Sources. WeChat requires separately authorized local tooling. Existing prompt overrides remain operator-owned; an upgrade does not silently rewrite them.

## 0.5.13

Initial public snapshot. Package name `dsh-superagent` is retained for DSH bundle compatibility; this repository does not publish that name to npm.
