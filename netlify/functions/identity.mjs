/* Netlify Identity event handler.
   Invoked by the platform, never called directly.

   Registration is left Open in the dashboard, and this handler is what keeps
   the app closed: anyone whose address is not on ALLOWED_EMAILS is denied at
   signup. Set that variable in Site configuration > Environment variables as
   a comma-separated list, e.g.

     ALLOWED_EMAILS = marco@company.com,luke@company.com,jessica@company.com

   Leaving it empty denies everyone, which fails safe rather than open. */

export default {
  userValidate(event) {
    const allowed = String(process.env.ALLOWED_EMAILS || '')
      .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    const email = String((event.user && event.user.email) || '').toLowerCase();
    if (!allowed.length || !allowed.includes(email)) return event.deny();
  }
};
