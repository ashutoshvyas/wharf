import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Twilio SMS and WhatsApp verification — WHARF",
  description: "Configure phone OTP delivery with Twilio, including WhatsApp and optional SMS fallback.",
};
const H2 = "mb-3 mt-9 text-xl font-semibold text-ink";
const P = "mb-3 text-sm leading-7 text-neutral-600";
const LINK = "text-cobalt-600 underline underline-offset-2";
export default function TwilioDocsPage() {
  return <main className="mx-auto max-w-[820px] px-6 py-14">
    <p className="label-track mb-2 text-neutral-500">WHARF · Integration guide</p>
    <h1 className="text-3xl font-bold tracking-tight text-ink">Twilio SMS and WhatsApp verification</h1>
    <p className={`${P} mt-4`}>Supabase creates and verifies the code. WHARF sends it through
      Twilio Programmable Messaging using the delivery channel selected for your instance.
      This integration does not use Twilio Verify.</p>
    <h2 className={H2}>Set up Twilio</h2>
    <ol className="list-decimal space-y-3 pl-5 text-sm leading-7 text-neutral-600">
      <li>Get the Account SID (AC…) and auth token from your Twilio account.</li>
      <li>For SMS, create a Messaging Service (MG…) containing an SMS-capable sender.
        Complete the sender registration and enable the destination countries your application serves.</li>
      <li>For WhatsApp, register a WhatsApp sender with Twilio. Create an authentication template
        with a copy-code button, have it approved, and copy its Content SID (HX…).
        The code must use variable 1. Match any expiration text to the code validity configured in WHARF.</li>
      <li>For WhatsApp with SMS fallback, configure both the WhatsApp sender/template and the SMS Messaging Service.</li>
    </ol>
    <p className={`${P} mt-4`}><a className={LINK} href="https://www.twilio.com/docs/whatsapp/self-sign-up">Register a WhatsApp sender</a>{" · "}
      <a className={LINK} href="https://www.twilio.com/docs/content/whatsappauthentication">Authentication templates</a>{" · "}
      <a className={LINK} href="https://www.twilio.com/docs/messaging/services">Messaging Services</a></p>
    <h2 className={H2}>Configure the instance in WHARF</h2>
    <p className={P}>Open the instance’s Auth settings → Providers → Phone. Allow phone sign-up
      and disable auto-confirm if you require verification. Select Twilio, choose SMS or WhatsApp,
      and enter the corresponding details. For WhatsApp, enable “Use SMS as fallback” if needed.
      Set the code lifetime and resend interval, then select “Save &amp; restart auth”.</p>
    <p className={P}>WHARF’s public HTTPS PANEL_URL must be reachable from the managed instance and Twilio.
      The signed delivery hook and per-message status callbacks are configured automatically.
      Credentials remain encrypted in WHARF. The panel must be running for delivery and fallback.</p>
    <h2 className={H2}>Application integration</h2>
    <p className={P}>Use the normal Supabase phone OTP flow. Omit the channel option: WHARF chooses
      SMS or WhatsApp from the instance settings. Make clear to users where the code will arrive
      and that SMS may be used if fallback is enabled. Request codes only when the user asks to verify.</p>
    <pre className="overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs leading-6">{`const { error: sendError } = await supabase.auth.signInWithOtp({
  phone: '+919999999999',
  // Set shouldCreateUser: false inside options for sign-in-only flows.
});

const { data, error: verifyError } = await supabase.auth.verifyOtp({
  phone: '+919999999999',
  token: codeEnteredByUser,
  type: 'sms', // Supabase's phone OTP type, even when delivered by WhatsApp.
});`}</pre>
    <p className={`${P} mt-4`}>For an authenticated phone-number change, call updateUser with the new phone,
      then verifyOtp with type “phone_change”. WHARF delivers to the new destination supplied by Auth.
      Phone MFA is outside this initial integration’s validated scope.</p>
    <h2 className={H2}>How fallback behaves</h2>
    <ul className="list-disc space-y-2 pl-5 text-sm leading-7 text-neutral-600">
      <li>A definite WhatsApp send rejection or a signed “failed”/“undelivered” status can trigger one SMS attempt.</li>
      <li>SMS carries the same code. Supabase still controls validity, confirmation and sessions.</li>
      <li>Pending or unread messages do not trigger a timed fallback. A network timeout is ambiguous:
        WHARF keeps the code valid and waits for a signed failure report instead of blindly sending again.</li>
      <li>Duplicate requests do not send another code. Expired and superseded attempts cannot start fallback.
        Turning fallback off or switching provider prevents new fallback attempts.</li>
      <li>If the SMS attempt also fails, there is no retry loop. The user can request a new code after the resend interval.
        A send request being accepted does not prove the message arrived or the phone was verified.</li>
    </ul>
    <h2 className={H2}>Operations and rollout</h2>
    <p className={P}>Deploy the database migration before the new panel version. Existing running instances retain their old
      delivery configuration until Auth settings are saved and restarted. Test SMS, WhatsApp, and fallback with
      approved senders and test recipients before enabling for customers. Trial and sandbox accounts have recipient restrictions.</p>
    <p className={P}>Delivery state survives panel restarts. Encrypted recipient/code/configuration snapshots are cleared
      on completion or supersession, and by a cleanup sweep within roughly one minute of expiry while WHARF is running.
      Expired payloads are never used to send. Replay records are deleted after 24 hours. Backups follow your existing retention policy.</p>
    <p className={P}>After an interrupted send, WHARF does not retry an uncertain outbound request automatically.
      If no callback arrives, the user must request a new code. Diagnose delivery using Twilio’s message logs;
      WHARF logs delivery IDs and error codes, never OTPs or raw provider responses.</p>
  </main>;
}
