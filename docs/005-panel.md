# 005 Panel

## Personal daily workspace

The standalone **Main conversation** entry sits above the workspace list and opens the existing orchestrator Session. The owner launcher defaults to `#main-conversation`; it does not create a new chat. Input, attachments and history remain native to DSH.

Main conversation and Personal workspace form the first two sidebar entries, with a primary conversation button and a quieter workspace button. Their short descriptions disappear in the compact icon rail. Today also links directly to the original Main Session. The workbench uses its full width until a specific matter's supplement is opened.

`#workbench` opens one daily panel with Today, Tickets, Source health and Settings. Today shows the coordinator's focus projection from current Tickets/Threads, decisions, ongoing work and recent results. Tickets retains full records and completed history. Source health and Settings reuse the existing management pages. The supplement area targets the selected Ticket; full discussion opens the same Main Session. Detailed execution stays in Ticket/worker records. The legacy `#superagent` entry still resolves stored management routes in this same daily panel, but no longer has a second sidebar entry.

Focus suggestions show their linked task or source update. Multiple suggestions can refer to one Ticket. Each ongoing task is one Ticket holding the delegation, authority, progress and results. The daily views explain their roles, and collaboration explains how discussion leads to explicit delegation. Task cards and details offer **End task** with confirmation, using the existing stop operation. The ended record and deliverables remain accessible. In a DSH-only profile, explicit continuation is available in the full work record.

The focus domain selector organizes suggestions by business scope. **Edit focus domains** opens the existing native Source settings rows for `workbench`, where domains can be added, renamed, removed or parked. Refresh the assessment after changing the definitions. The coordinator reads active domain definitions through `focus_context` and cites a domain ID when publishing each classified suggestion. A domain with no suggestion in the current assessment says so explicitly. Domain configuration organizes attention; actual collection, execution and authority remain with Sources and Tickets.

Active domains are visible as selectable cards. Counts describe suggestions in the current assessment, not all tasks or proof of source coverage; an unavailable assessment says it is awaiting assessment. Domain selection filters suggestions only. Necessary decisions remain visible above suggestions across all domains; when there are none, the page uses a quiet empty-state message. Each suggestion separates its title, reason and next step.

Daily task previews retain the API's real totals and link to the full existing list when truncated. Recent results describe their 24-hour window and offer full history. Detail deliverables come from the selected Ticket. Focus suggestions citing both a Ticket and Thread preserve and compare both read versions, and expose both evidence links. `focus_context` includes current package version, priority and due date so historical reports can be weighed against current runtime facts and delivery clocks.

In individual-matter mode, Sources retain collection checkpoints and the original read commission. Main/Eval attach evidence to an existing concrete goal, accept a new actionable goal under the owner's rules, or ignore it. The former catch-all monitoring Tickets complete their handoff and remain as historical authorization records. Each business Ticket owns its own progress, waiting condition, stop and outcome. An owner message explicitly listing independent goals can delegate them together with stable per-goal receipts. Automatic owned PR work reviews and merges each checked head in its own Ticket when the Source setting and standing rule permit it.

## Main conversation

The **Main Session** is the owner's primary interface: one conversation that sees every Ticket, answers what is running or waiting, accepts explicit work and receives results. Other Sessions are internal execution bodies and need not be opened.

The daily launcher opens `#main-conversation`, which selects and unarchives the existing Main Session. Above its native composer, **My work** shows global decisions, active work, waiting work and recent deliveries from the existing overview. Expanding a group exposes the latest report and next follow-up. Replies and revision requests carry the selected Ticket identity into the native owner conversation for routing to that same Ticket. Published local artifacts preview beside the conversation. **Personal workspace** opens the daily panel independently.

In a DSH-only profile, a stopped Ticket offers **Continue this work**. The owner supplies the next instruction; the same Ticket, workspace, history and results remain, with an explicit DSH handoff and a new Assignment. Old undelivered inputs are not replayed wholesale. Automatic events cannot invoke this action. Pause keeps a responsibility open; Stop ends it until the owner explicitly continues it. Discussion task cards distinguish queued, waiting, blocked and review states and show the next follow-up time.

Open **Personal workspace** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The daily tabs are **Today**, **Tickets**, **Source health**, and **Settings**. Existing Trigger and Eval records are linked from Source health. Today expands system problems in place, retaining their retry and dismiss actions. Refresh preserves the selected route.

| Page | Shows |
| --- | --- |
| Today | Focus suggestions, necessary decisions, ongoing work, recent results and expandable system problems |
| Tickets | Executor state, Pause processing, and Tickets filtered by Open, Pending, Working, Waiting for a Trigger or Ended. Ticket details show actions, authorization, waiting Inputs, Subscriptions and Assignments |
| Source health | Source state, setup problems and non-zero counts; links to Source events and Judgement history. Filtered Triggers and dropped messages cover the last 24 hours |
| Source events (detail) | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| Judgement history (detail) | Decisions with their reason and matched rules |
| Settings | Sources, Eval, Execution, Prompts and Deployment. Each group includes its save history |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts. GitHub also offers receive-all switches for new Issues, pull requests, comments and default-branch CI. Polling and read limits are under Advanced.
- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. Each Source tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent. Eval settings select the accept mode, timeout and assessment model.
- **Execution:** worker model, concurrency, directory root, prepare command and blocked commands. Clicking an available variable inserts it into the prepare command.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Threads and Triggers in Trigger; Decisions in Eval; Tickets in Execution. Settings are grouped by the concept they configure. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.
