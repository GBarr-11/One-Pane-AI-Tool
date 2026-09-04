'use strict';

/**
 * Mock corpus of previously resolved SMC tickets, used as precedent.
 *
 * `outcome` drives the filtering discussed in design: only cleanly resolved
 * tickets are eligible as precedent. Reopened / escalated tickets stay in the
 * corpus deliberately so the filter has something to exclude - a naive
 * implementation that skips this filter would happily cite them.
 *
 * `redactedFor` marks fields scrubbed before retrieved content reaches a draft,
 * so one client's identifying details can never bleed into another's reply.
 */

const RESOLVED_TICKETS = [
  {
    id: '3706143',
    subject: 'EEC2 post-cutover - VMware tools upgrade and DNS restore',
    client: '—',
    category: 'Service Delivery',
    problem: 'EEC Service Transition',
    closedAt: '2026-05-22',
    outcome: 'resolved',
    reopened: false,
    csat: 4,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['eec2', 'migration', 'dns', 'kernel panic', 'vmware tools', 'restore', 'transition'],
    resolutionNote:
      'VMware tools upgraded across migrated guests. DNS server restored from backup; kernel panic cleared and name resolution verified from inside EEC2. Confirmed backup jobs recreated against the new environment.',
  },
  {
    id: '3709884',
    subject: 'EEC1 decommission - confirm no residual dependencies',
    client: '—',
    category: 'Service Delivery',
    problem: 'EEC Service Transition',
    closedAt: '2026-06-30',
    outcome: 'resolved',
    reopened: false,
    csat: 5,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['eec1', 'decommission', 'transition', 'cleanup', 'sign-off'],
    resolutionNote:
      'Verified no residual production dependencies on EEC1 resources prior to decommission. Load balancer service groups confirmed to reflect post-migration state. Client signed off on closure.',
  },
  {
    id: '3698455',
    subject: 'VPN users not receiving MFA push after phone replacement',
    client: '—',
    category: 'Remote Access',
    problem: 'VPN Authentication',
    closedAt: '2026-07-30',
    outcome: 'resolved',
    reopened: false,
    csat: 5,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['vpn', 'mfa', 'push', 'authentication', 'enrollment', 'bypass code', 'notification'],
    resolutionNote:
      'Affected users had replaced handsets; MFA appliance logs showed no delivery attempt, confirming stale device registration. Issued single-use bypass codes to unblock immediately, then walked users through removing the stale account from the authenticator app and re-enrolling. All users authenticating normally after re-enrollment.',
  },
  {
    id: '3701240',
    subject: 'Nightly backup failing on snapshot creation - orphaned snapshot',
    client: '—',
    category: 'Backup & Recovery',
    problem: 'Backup Job Failure',
    closedAt: '2026-08-14',
    outcome: 'resolved',
    reopened: false,
    csat: 4,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['backup', 'snapshot', 'veeam', 'orphaned', 'consolidate', 'job failure', 'restore point'],
    resolutionNote:
      'Job failure traced to an orphaned snapshot left behind by a prior manual snapshot. Consolidated the snapshot chain, confirmed datastore headroom, and re-ran the job manually - completed clean. Confirmed prior restore points remained valid throughout; last good backup predated the failure window by one day.',
  },
  {
    id: '3688119',
    subject: 'Inbound rule request for third-party integration vendor',
    client: '—',
    category: 'Network Security',
    problem: 'Firewall Rule Change',
    closedAt: '2026-06-11',
    outcome: 'resolved',
    reopened: false,
    csat: 5,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['firewall', 'inbound', 'port', 'vendor', 'change control', 'rule', 'scoped'],
    resolutionNote:
      'Collected source IP, destination host/port, protocol, and business justification. Scoped the rule to the vendor source address rather than any/any and time-bound it to the integration test window. Implemented under standard change control with two business days lead time.',
  },
  {
    id: '3692077',
    subject: 'Public portal certificate renewal ahead of expiry',
    client: '—',
    category: 'Certificates',
    problem: 'Certificate Renewal',
    closedAt: '2026-07-08',
    outcome: 'resolved',
    reopened: false,
    csat: 5,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['certificate', 'ssl', 'tls', 'expiry', 'renewal', 'csr', 'load balancer', 'portal'],
    resolutionNote:
      'Confirmed the certificate was client-procured, so renewal ownership sat with them. Generated the CSR on the load balancer and sent it over, client returned the signed certificate and chain, installed and bound to the virtual server during a low-traffic window. Verified the full chain externally before closing, and set a 45-day advance reminder so the next renewal is not a fire drill.',
  },
  {
    id: '3699310',
    subject: 'Production datastore approaching capacity threshold',
    client: '—',
    category: 'Capacity',
    problem: 'Storage Capacity',
    closedAt: '2026-08-05',
    outcome: 'resolved',
    reopened: false,
    csat: 5,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['capacity', 'datastore', 'storage', 'snapshot', 'growth', 'reclaim', 'headroom', 'disk'],
    resolutionNote:
      'Broke the growth down before quoting anything: 60% of the recent increase was orphaned snapshots left by a backup job, the rest was uncompressed log retention on two guests. Consolidated the snapshots and applied log rotation, which reclaimed 780 GB and returned the datastore to 74%. Client chose to defer the storage add on the revised growth curve.',
  },
  {
    id: '3703588',
    subject: 'Outbound mail marked as spam after adding a third-party sender',
    client: '—',
    category: 'Email',
    problem: 'Mail Deliverability',
    closedAt: '2026-08-19',
    outcome: 'resolved',
    reopened: false,
    csat: 4,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['email', 'spf', 'dkim', 'dmarc', 'spam', 'deliverability', 'gmail', 'dns lookup limit'],
    resolutionNote:
      'SPF record had grown past the ten DNS lookup limit after a new bulk sender was added, so it evaluated as permerror and receivers fell back to their own heuristics. Flattened the record to bring lookups to seven, added the provider include, and enabled DKIM signing on the provider side. Left DMARC at p=none for two weeks to collect reports before moving to quarantine.',
  },
  {
    id: '3695442',
    subject: 'CNAME addition for agency-hosted campaign site',
    client: '—',
    category: 'DNS',
    problem: 'DNS Record Change',
    closedAt: '2026-07-16',
    outcome: 'resolved',
    reopened: false,
    csat: 5,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['dns', 'cname', 'record', 'ttl', 'change control', 'propagation', 'marketing'],
    resolutionNote:
      'Confirmed the target host resolved and served the expected certificate before making the change, which caught that the agency had supplied the staging hostname rather than production. Added the record with a 300 second TTL for the first 48 hours to keep rollback cheap, then raised it to 3600 once the campaign was confirmed live.',
  },
  {
    id: '3697801',
    subject: 'Single user locking out several times a day',
    client: '—',
    category: 'Identity',
    problem: 'Account Lockout',
    closedAt: '2026-07-24',
    outcome: 'resolved',
    reopened: false,
    csat: 5,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['lockout', 'account', 'password', 'active directory', 'cached credentials', 'mobile', 'identity'],
    resolutionNote:
      'Pulled lockout events from the domain controller security log and traced the bad password attempts to one source: a mobile device still presenting the old password to the mail profile after a reset. Removed and re-added the account on the handset. Lockouts stopped the same day. Noted that a password reset alone never fixes this - the stale credential has to be found on the device that is replaying it.',
  },
  {
    id: '3691255',
    subject: 'Request to move recurring patch window',
    client: '—',
    category: 'Maintenance',
    problem: 'Patch Window Change',
    closedAt: '2026-07-02',
    outcome: 'resolved',
    reopened: false,
    csat: 5,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['patching', 'maintenance window', 'schedule', 'change control', 'reboot', 'month-end'],
    resolutionNote:
      'Moved the recurring window after confirming the new slot did not collide with the backup window or another client in the same maintenance group. Updated the change control template and the client-facing calendar entry so the new schedule is what shows up in their notifications rather than only in our system.',
  },
  {
    id: '3686930',
    subject: 'Formal escalation following repeat incidents on one service',
    client: '—',
    category: 'Service Delivery',
    problem: 'Repeat Incident',
    closedAt: '2026-06-27',
    outcome: 'resolved',
    reopened: false,
    csat: 4,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['escalation', 'root cause', 'rca', 'sla', 'service credit', 'repeat incident', 'postmortem'],
    resolutionNote:
      'Treated the pattern rather than the third incident: produced one written RCA covering all three events, which showed a common cause the individual tickets had each missed. Named an owner and a date for each corrective action rather than promising improvement generally. Service credit calculated against the SLA and applied without requiring the client to chase it. Client accepted and the account stabilised.',
  },

  // --- Deliberately poor precedent: must be excluded by the outcome filter ---
  {
    id: '3612880',
    subject: 'VPN login problems - users cannot connect',
    client: '—',
    category: 'Remote Access',
    problem: 'VPN Authentication',
    closedAt: '2026-03-04',
    outcome: 'reopened',
    reopened: true,
    csat: 2,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['vpn', 'mfa', 'push', 'authentication', 'login'],
    resolutionNote:
      'Advised users to reboot their machines and retry. Ticket closed. Reopened four days later - underlying MFA enrollment issue had not been addressed and the same users were blocked again.',
  },
  {
    id: '3655302',
    subject: 'Backup alerts firing nightly',
    client: '—',
    category: 'Backup & Recovery',
    problem: 'Backup Job Failure',
    closedAt: '2026-04-22',
    outcome: 'escalated',
    reopened: true,
    csat: 2,
    redactedFor: ['client', 'contact', 'hostnames'],
    tags: ['backup', 'alert', 'snapshot', 'job failure'],
    resolutionNote:
      'Suppressed the alerting rule to stop the nightly noise. Escalated after client identified that backups had not actually run for eleven days.',
  },
];

/** Only cleanly resolved tickets are eligible to be cited as precedent. */
function eligiblePrecedent() {
  return RESOLVED_TICKETS.filter(
    (t) => t.outcome === 'resolved' && !t.reopened && (t.csat === undefined || t.csat >= 3),
  );
}

module.exports = { RESOLVED_TICKETS, eligiblePrecedent };
