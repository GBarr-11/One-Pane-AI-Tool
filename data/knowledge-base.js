'use strict';

/**
 * Mock internal techdocs / knowledgebase.
 *
 * Each doc carries a `replyTemplate` - the house-standard shape for a reply on
 * this topic. The offline mock generator fills these in; the real Claude
 * provider receives them as reference material rather than as a rigid template,
 * which is what produces uniformity without every reply reading identically.
 *
 * Placeholders: {{contact}} {{ticketId}} {{client}} and doc-specific fields
 * resolved by the generator from ticket context.
 */

const KNOWLEDGE_BASE = [
  {
    id: 'KB-1042',
    title: 'EEC Service Transition - closure & sign-off runbook',
    category: 'Service Delivery',
    updated: '2026-06-02',
    tags: ['eec', 'eec2', 'migration', 'transition', 'cutover', 'decommission', 'sign-off', 'resolve'],
    body: `Once all post-cutover remediation items on an EEC1 to EEC2 transition are closed,
the assigned analyst confirms the following before proposing ticket closure:
(1) every VM flagged during cutover is recreated or restored and confirmed healthy;
(2) DNS and name resolution verified from inside the new environment;
(3) backup and replication jobs recreated against EEC2 with at least one successful run logged;
(4) load balancer service groups reflect the intended post-migration state.
The closure note should recap each remediated item explicitly rather than saying
"all issues resolved" - clients on long-running transition tickets consistently ask
for the itemized list. Offer to hold the ticket open if the client wants more soak time.`,
    replyTemplate: {
      opener: 'The service transition to Expedient Enterprise Cloud (EEC2) is now <b>complete</b>. Here is a recap of what has been resolved since the cutover:',
      closer: 'We have not seen any new issues reported since these fixes went in. If everything looks good on your end, we will go ahead and <b>resolve this ticket</b> — just let us know if you would like us to hold off.',
    },
  },

  {
    id: 'KB-0311',
    title: 'Remote access VPN - MFA push not delivered',
    category: 'Remote Access',
    updated: '2026-07-19',
    tags: ['vpn', 'mfa', 'push', 'authentication', 'login', 'remote access', 'token', 'duo', 'multifactor', 'notification'],
    body: `When a user authenticates successfully but never receives the MFA push, the
failure is almost always device-side rather than credential-side. Triage order:
(1) confirm the user's device is still enrolled and has not been replaced or factory reset;
(2) check the MFA appliance logs for a delivery attempt - no attempt logged means the
device registration is stale and must be re-enrolled;
(3) verify the device has network connectivity and that push notifications are not
suppressed by OS-level battery optimization or notification settings;
(4) as an interim unblock, issue a bypass code so the user can work while re-enrollment
is completed. Bypass codes are single-use and expire after 24 hours.
Re-enrollment requires the user to remove the existing account from the authenticator
app before scanning the new QR code, otherwise the old token continues to be used.`,
    replyTemplate: {
      opener: 'Thanks for reporting this. A successful password prompt with no push notification almost always points to the enrolled device rather than the account itself.',
      closer: 'If you can confirm whether the affected users have recently replaced or reset their phones, that will tell us quickly whether re-enrollment is the fix. In the meantime we can issue single-use bypass codes so they are not blocked.',
    },
  },

  {
    id: 'KB-0788',
    title: 'Backup job failure - VM snapshot creation errors',
    category: 'Backup & Recovery',
    updated: '2026-08-11',
    tags: ['backup', 'veeam', 'snapshot', 'job', 'failure', 'restore', 'retention', 'recovery', 'vbr'],
    body: `Snapshot creation failures are most often caused by an existing orphaned snapshot,
insufficient datastore free space, or a stale VMware tools installation on the guest.
Triage order:
(1) check datastore free space - snapshot creation requires headroom equal to the
active VM disk delta;
(2) look for orphaned or consolidated-pending snapshots on the VM and consolidate;
(3) confirm VMware tools is current on the guest;
(4) re-run the job manually once remediation is applied rather than waiting for the
next scheduled window.
When communicating with the client, always state explicitly which restore points are
still valid and the exact date of the last good backup. Clients under audit or
compliance pressure need the recovery position stated plainly, not implied.
Do not describe a backup gap as "minor" - state the window and the retained restore points.`,
    replyTemplate: {
      opener: 'Thanks for following up. Here is exactly where your backup coverage stands:',
      closer: 'Once the underlying snapshot issue is cleared we will re-run the job manually rather than waiting for the next scheduled window, and confirm a clean run back to you.',
    },
  },

  {
    id: 'KB-0455',
    title: 'Firewall rule change requests - intake and change control',
    category: 'Network Security',
    updated: '2026-05-30',
    tags: ['firewall', 'rule', 'port', 'inbound', 'change control', 'acl', 'nat', 'vendor', 'access'],
    body: `Inbound firewall rule requests require a change control record before implementation.
Required intake details before the change can be scheduled:
(1) source IP or CIDR;
(2) destination host and port;
(3) protocol;
(4) business justification and requesting party;
(5) whether the access is permanent or time-bound.
Inbound rules from a third party should be scoped to the specific source address rather
than any/any, and time-bound where the vendor only needs test-window access.
Standard change control lead time is two business days for a non-emergency change.
Confirm the requested implementation window back to the client explicitly - clients
frequently assume same-day turnaround on inbound rule requests.`,
    replyTemplate: {
      opener: 'Happy to get this scoped for you. Inbound rule changes go through change control, so I want to confirm the details before we schedule it:',
      closer: 'Standard lead time for a non-emergency change is two business days. If you can confirm the details above today, we can target implementation ahead of your Monday test window.',
    },
  },

  {
    id: 'KB-0102',
    title: 'Client communication standards - tone, structure, and formatting',
    category: 'General',
    updated: '2026-04-15',
    tags: ['communication', 'tone', 'formatting', 'style', 'standards', 'reply', 'writing'],
    body: `All customer-facing ticket replies follow the same shape: acknowledge, state
current status, list concrete facts, state the next action and who owns it, then close
with a clear ask or confirmation request.
Formatting: SMC supports a limited HTML subset. Use <b> for emphasis on status words,
<ul>/<li> for any list of two or more items, and <code> or <pre> for hostnames, IPs,
commands, and error strings. Do not use headers, tables, or inline styles - they do not
render.
Never speculate about root cause in a customer-facing note before it is confirmed.
Never commit to a delivery date that has not been agreed internally.
Address the customer by first name. Sign-off is handled by the SMC template - do not
add a closing signature block.`,
    replyTemplate: null,
  },

  {
    id: 'KB-0620',
    title: 'TLS certificate renewal - ownership, CSR, and installation',
    category: 'Certificates',
    updated: '2026-07-10',
    tags: ['certificate', 'ssl', 'tls', 'expiry', 'renewal', 'csr', 'chain', 'portal', 'load balancer', 'https'],
    body: `Renewal ownership depends on who procured the certificate. Expedient-procured
certificates are renewed by us automatically. Client-procured certificates are renewed by
the client; our part is to generate the CSR on the terminating device and install what
comes back. Establish which case applies before promising anything - getting this wrong
is the single most common cause of an avoidable expiry outage.
Procedure: generate the CSR on the device that terminates TLS, send it to the client,
receive the signed certificate plus the full intermediate chain, install, and bind to the
virtual server. Install during a low-traffic window; binding briefly resets connections.
Always verify the full chain from outside the network before closing - a certificate that
validates internally can still fail for external users when an intermediate is missing.
Set an advance reminder at 45 days for the next cycle.`,
    replyTemplate: {
      opener: 'Thanks for flagging the expiry notice. Here is where this one sits and what we need from each side:',
      closer: 'Once we have the signed certificate and its intermediate chain back from you we will install it and verify externally before we call it done. Send it over whenever you have it and we will handle the rest.',
    },
  },

  {
    id: 'KB-0533',
    title: 'Datastore capacity warnings - find the cause before quoting capacity',
    category: 'Capacity',
    updated: '2026-08-06',
    tags: ['capacity', 'datastore', 'storage', 'disk', 'snapshot', 'growth', 'headroom', 'reclaim', 'threshold'],
    body: `A capacity alert is a question, not an order for more storage. Before quoting an
add, account for what is consuming the space. In practice most unexplained growth on a
managed datastore comes from one of three things: orphaned snapshots left behind by a
backup job or a manual snapshot, log files without rotation, or a guest that has been
resized without anyone noting it.
Report the breakdown to the client with numbers, not adjectives - how much each
contributor accounts for, how much is reclaimable, and what the growth rate implies for
remaining headroom in days. Then present reclaim and expansion as options with costs
rather than steering to the purchase.
Escalate ahead of the threshold rather than at it: a datastore that fills stops writes and
takes an outage with it.`,
    replyTemplate: {
      opener: 'We looked into what is actually driving the growth before recommending anything. Here is what we found:',
      closer: 'Our recommendation is to reclaim what we can first and re-measure the growth rate before deciding on additional capacity. Let us know how you would like to proceed and we will schedule it.',
    },
  },

  {
    id: 'KB-0912',
    title: 'Outbound mail deliverability - SPF, DKIM, and DMARC',
    category: 'Email',
    updated: '2026-08-20',
    tags: ['email', 'spf', 'dkim', 'dmarc', 'spam', 'junk', 'deliverability', 'sender', 'gmail', 'mail flow'],
    body: `When previously reliable mail starts landing in junk, look first at what changed
about who is sending on the domain's behalf. Adding a bulk sender or marketing platform
without updating SPF is the usual cause.
Check in this order: (1) does SPF include every service that sends as the domain;
(2) does the record stay within the ten DNS lookup limit - exceeding it produces a
permerror and receivers fall back to their own heuristics, which looks identical to
"randomly going to spam"; (3) is DKIM signing enabled and the key published for each
sender; (4) what does DMARC report show, and is the policy appropriate.
Flatten or consolidate includes to get back under the lookup limit rather than removing
legitimate senders. Move DMARC from p=none to quarantine only after reports show
authenticated mail is passing cleanly.`,
    replyTemplate: {
      opener: 'We have looked at the sending records for the domain and this lines up with the change you described. Here is what we found:',
      closer: 'We can make the record changes under standard change control once you confirm the provider details. Delivery usually improves within a few hours of the records propagating, and we will watch the reports for a couple of weeks before tightening the policy further.',
    },
  },

  {
    id: 'KB-0274',
    title: 'DNS record change requests - validation and TTL handling',
    category: 'DNS',
    updated: '2026-07-18',
    tags: ['dns', 'cname', 'a record', 'ttl', 'record', 'change control', 'propagation', 'resolve'],
    body: `Validate the target before creating the record. Confirm the destination hostname
resolves and, for anything served over HTTPS, that it presents a certificate valid for the
name being pointed at it. This routinely catches staging hostnames supplied by mistake,
which is much cheaper to find before the record is live than after.
Lower the TTL to 300 seconds for the first 24-48 hours of any new or changed record so a
rollback takes minutes rather than hours, then raise it back to the standard value once
the change is confirmed good.
CNAMEs cannot coexist with other records at the same name and cannot be used at a zone
apex. Where a client asks for an apex CNAME, offer ALIAS/ANAME or an A record against the
provider's documented addresses instead.
Standard DNS changes are same-business-day; state the window rather than implying instant.`,
    replyTemplate: {
      opener: 'Happy to get this added. Before we create the record we validate the target, and here is where that stands:',
      closer: 'We will set a short TTL for the first day or so in case anything needs backing out quickly, then return it to standard. Confirm the target is the production hostname and we will schedule the change.',
    },
  },

  {
    id: 'KB-0101',
    title: 'Repeated account lockouts - finding the source of bad password attempts',
    category: 'Identity',
    updated: '2026-07-25',
    tags: ['lockout', 'account', 'password', 'active directory', 'credentials', 'mobile', 'identity', 'authentication'],
    body: `A password reset does not resolve a repeating lockout on its own. The lockout is
caused by something replaying an old credential, and until that source is found the reset
simply restarts the cycle - which is exactly what the user experiences as "it happens
again an hour later".
Find the source from the domain controller security log: event 4740 records the lockout
and the caller computer name, and 4771/4625 show the bad password attempts with their
origin. The usual culprits are a mobile mail profile holding the previous password, a
mapped drive or scheduled task running as the user, a stale session on a second machine,
or a service account credential stored on a server.
Ask what devices the user has before starting - the answer usually narrows it to one.
Resolve by clearing the stored credential on the offending device, not by resetting again.`,
    replyTemplate: {
      opener: 'This pattern - reset, works for an hour, locks again - almost always means something is still presenting the old password. Here is how we track that down:',
      closer: 'If you can confirm the devices she signs in from, we will pull the lockout events and identify which one is replaying the old credential. That is the piece that actually stops it recurring.',
    },
  },

  {
    id: 'KB-0845',
    title: 'Changing a recurring maintenance or patch window',
    category: 'Maintenance',
    updated: '2026-07-03',
    tags: ['patching', 'maintenance window', 'schedule', 'reboot', 'change control', 'recurring', 'calendar'],
    body: `Recurring window changes are straightforward but have two dependencies worth
checking before agreeing to a date: whether the proposed slot collides with the backup
window on the same hosts, and whether the client shares a maintenance group with others
whose windows would need to move too.
Patch windows include reboots. Where a client has a database or application that needs an
ordered shutdown, confirm the sequence is still correct for the new slot.
Update the change control template and the client-facing calendar entry, not only the
internal schedule - clients see the notification, not our system, and a schedule changed
in one place but not the other produces an unexpected reboot.
Confirm the first occurrence under the new schedule explicitly.`,
    replyTemplate: {
      opener: 'We can move that. Before we lock it in we check the new slot against a couple of dependencies:',
      closer: 'Confirm the proposed slot works on your side and we will update the recurring change control and your calendar entry, then confirm the first occurrence under the new schedule.',
    },
  },

  {
    id: 'KB-0399',
    title: 'Repeat incidents and formal escalations - RCA and service credits',
    category: 'Service Delivery',
    updated: '2026-08-11',
    tags: ['escalation', 'root cause', 'rca', 'repeat incident', 'sla', 'service credit', 'postmortem', 'complaint'],
    body: `When a client escalates on a pattern rather than a single incident, responding
about the most recent incident alone reads as missing the point, because it is.
Produce one written RCA covering every incident named, not three separate ones. A common
cause is frequently visible across the set that each individual ticket missed - and if the
incidents genuinely are unrelated, say so plainly and show the analysis that establishes
it.
Corrective actions need a named owner and a date each. "We will improve monitoring" is
what the client has already been told and did not believe.
Where an SLA credit applies, calculate and apply it without making the client chase it,
and state the calculation. Do not dispute entitlement in a first reply.
Acknowledge the impact on them specifically before describing our process. Never open by
defending the previous responses.`,
    replyTemplate: {
      opener: 'You are right to escalate this, and I want to respond to the pattern rather than just the most recent outage. Here is what we are committing to:',
      closer: 'I will own this personally through to the RCA being delivered. If you would like to walk through it live once you have had a chance to read it, I will make the time.',
    },
  },
];

function listDocs() {
  return KNOWLEDGE_BASE.map(({ id, title, category, updated }) => ({ id, title, category, updated }));
}

module.exports = { KNOWLEDGE_BASE, listDocs };
