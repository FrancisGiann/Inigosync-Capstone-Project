const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function staffResendSubject(now = new Date()) {
  const sentAt = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(now);
  return `Your InigoSync staff setup - ${sentAt} PHT`;
}

export function buildStaffOnboardingEmail({ email, position, password, loginUrl, subject = 'Your InigoSync staff account' }) {
  const safeEmail = escapeHtml(email);
  const safePosition = escapeHtml(position);
  const safePassword = escapeHtml(password);
  const safeLoginUrl = escapeHtml(loginUrl);
  return {
    to: [email],
    subject,
    text: `Your ${position} staff account is ready.\n\nSign in: ${loginUrl}\nEmail: ${email}\nTemporary password: ${password}\n\nAfter signing in, choose a new password and complete setup. This password has no time limit; an owner resend replaces it.`,
    html: `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#171717"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e5e5"><tr><td style="height:6px;background:#ff7900;font-size:0">&nbsp;</td></tr><tr><td style="padding:20px 22px"><strong style="font-size:22px">Iñigo<span style="color:#ff7900">Sync</span></strong><div style="margin-top:2px;color:#777;font-size:10px;font-weight:bold;letter-spacing:1.5px">SPORT CENTER</div><p style="margin:20px 0 6px;color:#b94700;font-size:12px;font-weight:bold;letter-spacing:1px">STAFF SETUP</p><h1 style="margin:0 0 10px;font-size:22px">Your account is ready</h1><p style="margin:0 0 16px;color:#505050;line-height:1.5">Sign in to finish setting up your ${safePosition} account.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f7f7;border:1px solid #e7e7e7"><tr><td style="padding:13px 14px;font-size:14px;line-height:1.6"><span style="color:#666">EMAIL</span><br><strong>${safeEmail}</strong><br><br><span style="color:#666">TEMPORARY PASSWORD</span><br><strong style="font-size:19px;letter-spacing:1px">${safePassword}</strong></td></tr></table><p style="margin:16px 0"><a href="${safeLoginUrl}" style="display:inline-block;padding:11px 17px;background:#ff7900;color:#171717;font-weight:bold;text-decoration:none">Sign in to InigoSync</a></p><p style="margin:0;color:#505050;font-size:13px;line-height:1.5">After signing in, choose a new password and complete setup. This password has no time limit; an owner resend replaces it.</p></td></tr></table></body></html>`,
  };
}
