/**
 * Deliberately legacy HTML rendering for the mock console.
 *
 * Design choices that make this a realistic "hostile surface":
 *  - table-based layout, inline styles, no CSS framework
 *  - NO data-testid / aria roles on interactive controls
 *  - form controls are <input type="submit"> inside nested tables
 *  - the member's balances live inside an <iframe> (frame traversal required)
 *  - link/button text is the only semantically stable hook in many places
 */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function page(title: string, body: string, opts: { bare?: boolean } = {}): string {
  if (opts.bare) {
    return `<!DOCTYPE html><html><head><title>${esc(title)}</title></head>
<body style="margin:0;font-family:Verdana,Geneva,sans-serif;font-size:12px;color:#1a1a1a;background:#fff">
${body}
</body></html>`;
  }
  return `<!DOCTYPE html><html><head><title>${esc(title)}</title>
<meta http-equiv="X-UA-Compatible" content="IE=edge">
</head>
<body style="margin:0;font-family:Verdana,Geneva,sans-serif;font-size:12px;color:#1a1a1a;background:#e8e8ec">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1f3a5f;color:#fff">
  <tr>
    <td style="padding:8px 14px;font-size:15px;font-weight:bold;letter-spacing:1px">MERIDIAN CORE</td>
    <td align="right" style="padding:8px 14px;font-size:11px">Servicing Console v4.2.11 &nbsp;|&nbsp; Operator: opr-4821 &nbsp;|&nbsp; <a href="/logout" style="color:#cdd9ea">Sign out</a></td>
  </tr>
</table>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#33517a;color:#dfe7f2;font-size:11px">
  <tr><td style="padding:5px 14px">
    <a href="/dashboard" style="color:#dfe7f2;text-decoration:none">Dashboard</a> &nbsp;&raquo;&nbsp;
    <a href="/members" style="color:#dfe7f2;text-decoration:none">Member Search</a>
  </td></tr>
</table>
<table width="760" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:18px auto;background:#fff;border:1px solid #b7b7c2">
  <tr><td style="padding:18px 22px">
${body}
  </td></tr>
</table>
<table width="760" align="center" cellpadding="0" cellspacing="0" border="0">
  <tr><td style="padding:6px 22px;color:#7a7a86;font-size:10px">
    CONFIDENTIAL &mdash; Contains nonpublic personal information. Access is logged.
  </td></tr>
</table>
</body></html>`;
}

export function loginPage(error?: string, notice?: string): string {
  return page(
    'Sign In - Meridian Core',
    `
<h2 style="margin:0 0 14px;font-size:16px;color:#1f3a5f">Operator Sign In</h2>
${notice ? `<p style="background:#fff6da;border:1px solid #e0c65a;padding:8px 10px;color:#7a5c00">${esc(notice)}</p>` : ''}
${error ? `<p style="background:#fde8e8;border:1px solid #d99;padding:8px 10px;color:#a11">${esc(error)}</p>` : ''}
<form method="POST" action="/login">
  <table cellpadding="4" cellspacing="0" border="0">
    <tr><td>User ID</td><td><input type="text" name="userid" size="24" style="border:1px solid #999;padding:3px"></td></tr>
    <tr><td>Password</td><td><input type="password" name="password" size="24" style="border:1px solid #999;padding:3px"></td></tr>
    <tr><td></td><td style="padding-top:8px"><input type="submit" value="Sign In" style="padding:4px 16px"></td></tr>
  </table>
</form>
<p style="color:#7a7a86;font-size:10px;margin-top:16px">Test credentials: operator / password123</p>
`,
  );
}

export function dashboardPage(): string {
  return page(
    'Dashboard - Meridian Core',
    `
<h2 style="margin:0 0 14px;font-size:16px;color:#1f3a5f">Dashboard</h2>
<table cellpadding="6" cellspacing="0" border="0" width="100%">
  <tr valign="top">
    <td width="50%">
      <b>Quick actions</b>
      <ul style="margin:6px 0;padding-left:18px">
        <li><a href="/members">Member Search</a></li>
      </ul>
    </td>
    <td width="50%">
      <b>Notices</b>
      <p style="margin:6px 0;color:#555">Nightly batch completed 03:14. No exceptions.</p>
    </td>
  </tr>
</table>
`,
  );
}

export function searchPage(query: string, results: { id: string; name: string; branch: string }[], searched: boolean): string {
  const rows = results
    .map(
      (r) => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #ddd">${esc(r.id)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #ddd"><a href="/members/${esc(r.id)}">${esc(r.name)}</a></td>
      <td style="padding:4px 8px;border-bottom:1px solid #ddd">${esc(r.branch)}</td>
    </tr>`,
    )
    .join('');
  return page(
    'Member Search - Meridian Core',
    `
<h2 style="margin:0 0 14px;font-size:16px;color:#1f3a5f">Member Search</h2>
<form method="GET" action="/members">
  <table cellpadding="4" cellspacing="0" border="0"><tr>
    <td>Member ID or last name</td>
    <td><input type="text" name="q" value="${esc(query)}" size="28" style="border:1px solid #999;padding:3px"></td>
    <td><input type="submit" value="Search" style="padding:3px 14px"></td>
  </tr></table>
</form>
${
  searched
    ? results.length
      ? `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:12px;border:1px solid #ccc">
    <tr style="background:#eef1f6"><td style="padding:5px 8px"><b>ID</b></td><td style="padding:5px 8px"><b>Name</b></td><td style="padding:5px 8px"><b>Branch</b></td></tr>
    ${rows}
  </table>`
      : `<p style="margin-top:12px;color:#a11">No members matched "${esc(query)}".</p>`
    : ''
}
`,
  );
}

export function memberDetailPage(m: {
  id: string;
  firstName: string;
  lastName: string;
  ssnLast4: string;
  phone: string;
  email: string;
  memberSince: string;
  branch: string;
}): string {
  return page(
    `Member ${m.id} - Meridian Core`,
    `
<h2 style="margin:0 0 4px;font-size:16px;color:#1f3a5f">${esc(m.firstName)} ${esc(m.lastName)}</h2>
<p style="margin:0 0 14px;color:#555">Member #${esc(m.id)} &nbsp;&middot;&nbsp; ${esc(m.branch)} branch &nbsp;&middot;&nbsp; Member since ${esc(m.memberSince)}</p>

<table cellpadding="3" cellspacing="0" border="0" style="margin-bottom:16px">
  <tr><td style="color:#777">SSN</td><td>***-**-${esc(m.ssnLast4)}</td></tr>
  <tr><td style="color:#777">Phone</td><td>${esc(m.phone)}</td></tr>
  <tr><td style="color:#777">Email</td><td>${esc(m.email)}</td></tr>
</table>

<b style="color:#1f3a5f">Account Summary</b>
<div style="border:1px solid #ccc;margin:6px 0 16px">
  <iframe src="/members/${esc(m.id)}/summary" width="100%" height="150" frameborder="0" style="display:block"></iframe>
</div>

<table cellpadding="0" cellspacing="0" border="0"><tr>
  <td><a href="/members/${esc(m.id)}/sub-account/new" style="display:inline-block;padding:5px 14px;background:#1f3a5f;color:#fff;text-decoration:none">Open Sub-Account</a></td>
  <td style="padding-left:10px"><a href="/members">Back to search</a></td>
</tr></table>
`,
  );
}

export function memberSummaryFrame(
  accounts: { number: string; type: string; status: string; balance: string; openedOn: string }[],
): string {
  const rows = accounts
    .map(
      (a) => `
    <tr>
      <td style="padding:3px 8px;border-bottom:1px solid #e5e5e5">${esc(a.number)}</td>
      <td style="padding:3px 8px;border-bottom:1px solid #e5e5e5">${esc(a.type)}</td>
      <td style="padding:3px 8px;border-bottom:1px solid #e5e5e5">${esc(a.status)}</td>
      <td style="padding:3px 8px;border-bottom:1px solid #e5e5e5" align="right">${esc(a.balance)}</td>
    </tr>`,
    )
    .join('');
  return page(
    'Account Summary',
    `
<table cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr style="background:#eef1f6">
    <td style="padding:4px 8px"><b>Account</b></td>
    <td style="padding:4px 8px"><b>Type</b></td>
    <td style="padding:4px 8px"><b>Status</b></td>
    <td style="padding:4px 8px" align="right"><b>Current Balance</b></td>
  </tr>
  ${rows}
</table>
`,
    { bare: true },
  );
}

export function subAccountFormPage(memberId: string, memberName: string, error?: string, prev?: Record<string, string>): string {
  const v = (k: string) => esc(prev?.[k] ?? '');
  return page(
    `Open Sub-Account - Member ${memberId}`,
    `
<h2 style="margin:0 0 4px;font-size:16px;color:#1f3a5f">Open Sub-Account</h2>
<p style="margin:0 0 14px;color:#555">For ${esc(memberName)} (Member #${esc(memberId)})</p>
${error ? `<p style="background:#fde8e8;border:1px solid #d99;padding:8px 10px;color:#a11">${esc(error)}</p>` : ''}
<form method="POST" action="/members/${esc(memberId)}/sub-account/review">
  <table cellpadding="5" cellspacing="0" border="0">
    <tr><td>Product</td><td>
      <select name="product" style="border:1px solid #999;padding:3px">
        <option value="">-- select --</option>
        <option value="Regular Savings"${v('product') === 'Regular Savings' ? ' selected' : ''}>Regular Savings</option>
        <option value="Holiday Club"${v('product') === 'Holiday Club' ? ' selected' : ''}>Holiday Club</option>
        <option value="Youth Savings"${v('product') === 'Youth Savings' ? ' selected' : ''}>Youth Savings</option>
      </select></td></tr>
    <tr><td>Nickname</td><td><input type="text" name="nickname" value="${v('nickname')}" size="26" style="border:1px solid #999;padding:3px"></td></tr>
    <tr><td>Initial deposit (USD)</td><td><input type="text" name="initialDeposit" value="${v('initialDeposit')}" size="12" style="border:1px solid #999;padding:3px"></td></tr>
    <tr><td></td><td style="padding-top:8px"><input type="submit" value="Continue to Review" style="padding:4px 16px"></td></tr>
  </table>
</form>
`,
  );
}

export function subAccountReviewPage(
  memberId: string,
  memberName: string,
  fields: { product: string; nickname: string; initialDeposit: string },
): string {
  return page(
    `Review Sub-Account - Member ${memberId}`,
    `
<h2 style="margin:0 0 4px;font-size:16px;color:#1f3a5f">Review New Sub-Account</h2>
<p style="margin:0 0 14px;color:#555">Confirm the details below before submitting.</p>
<table cellpadding="5" cellspacing="0" border="0" style="border:1px solid #ccc;margin-bottom:14px">
  <tr><td style="color:#777">Member</td><td>${esc(memberName)} (#${esc(memberId)})</td></tr>
  <tr><td style="color:#777">Product</td><td>${esc(fields.product)}</td></tr>
  <tr><td style="color:#777">Nickname</td><td>${esc(fields.nickname || '(none)')}</td></tr>
  <tr><td style="color:#777">Initial deposit</td><td>${esc(fields.initialDeposit)}</td></tr>
</table>
<form method="POST" action="/members/${esc(memberId)}/sub-account/confirm">
  <input type="hidden" name="product" value="${esc(fields.product)}">
  <input type="hidden" name="nickname" value="${esc(fields.nickname)}">
  <input type="hidden" name="initialDeposit" value="${esc(fields.initialDeposit)}">
  <table cellpadding="0" cellspacing="0" border="0"><tr>
    <td><input type="submit" value="Submit Sub-Account" style="padding:5px 16px;background:#1f3a5f;color:#fff;border:0"></td>
    <td style="padding-left:10px"><a href="/members/${esc(memberId)}/sub-account/new">Edit</a></td>
  </tr></table>
</form>
`,
  );
}

export function subAccountConfirmationPage(
  memberId: string,
  memberName: string,
  newAccountNumber: string,
  fields: { product: string; initialDeposit: string },
): string {
  return page(
    `Sub-Account Opened - Member ${memberId}`,
    `
<div style="background:#e7f5e9;border:1px solid #7bbf86;padding:10px 12px;margin-bottom:14px">
  <b style="color:#1c6b2c">Sub-account opened successfully.</b>
</div>
<table cellpadding="5" cellspacing="0" border="0" style="border:1px solid #ccc">
  <tr><td style="color:#777">New account number</td><td><b>${esc(newAccountNumber)}</b></td></tr>
  <tr><td style="color:#777">Member</td><td>${esc(memberName)} (#${esc(memberId)})</td></tr>
  <tr><td style="color:#777">Product</td><td>${esc(fields.product)}</td></tr>
  <tr><td style="color:#777">Initial deposit</td><td>${esc(fields.initialDeposit)}</td></tr>
  <tr><td style="color:#777">Reference</td><td>CONF-${esc(memberId)}-${esc(newAccountNumber.slice(-2))}</td></tr>
</table>
<p style="margin-top:14px"><a href="/members/${esc(memberId)}">Return to member</a></p>
`,
  );
}

export function errorPage(kind: 'not-found' | 'permission' | 'app-error' | 'session', detail: string): string {
  const titles = {
    'not-found': 'Record Not Found',
    permission: 'Authorization Required',
    'app-error': 'System Error',
    session: 'Session Ended',
  };
  const colors = { 'not-found': '#7a5c00', permission: '#a11', 'app-error': '#a11', session: '#7a5c00' };
  return page(
    `${titles[kind]} - Meridian Core`,
    `
<h2 style="margin:0 0 12px;font-size:16px;color:${colors[kind]}">${titles[kind]}</h2>
<p style="background:#f6f6f6;border:1px solid #ccc;padding:10px 12px">${esc(detail)}</p>
<p style="margin-top:12px"><a href="/dashboard">Return to dashboard</a></p>
`,
  );
}

export function maintenanceInterstitial(returnTo: string): string {
  // An unexpected confirmation dialog the agent/replay must dismiss to proceed.
  return page(
    'Notice - Meridian Core',
    `
<h2 style="margin:0 0 12px;font-size:16px;color:#7a5c00">Scheduled Maintenance Notice</h2>
<p style="background:#fff6da;border:1px solid #e0c65a;padding:10px 12px">
  A maintenance window is scheduled for 22:00&ndash;23:00 ET. Read-only operations are unaffected.
  You must acknowledge this notice to continue.
</p>
<form method="POST" action="/_ack">
  <input type="hidden" name="returnTo" value="${esc(returnTo)}">
  <input type="submit" value="Acknowledge and Continue" style="padding:5px 16px">
</form>
`,
  );
}
