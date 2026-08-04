/**
 * Public MSG91 integration guide — deliberately reachable without a
 * login (see middleware.ts's PUBLIC_PATHS), because the people who do this
 * work are usually not the people with a WHARF account: the DLT registration
 * and template approval happen in someone else's MSG91 console, often at a
 * client or an agency.
 *
 * Static content only. Nothing here reads an instance, a setting or a
 * secret — it must stay safe to hand to anyone, so it documents the shape of
 * the integration and points at where each value lives rather than showing
 * any of them.
 */
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sending phone OTPs with MSG91 — WHARF",
  description:
    "How to connect an MSG91 account to a WHARF-managed Supabase instance so phone sign-up can deliver verification codes.",
};

const CARD = "rounded-[10px] border border-neutral-200 bg-white p-5";
const H2 = "mb-3 mt-10 text-[19px] font-semibold tracking-[-0.01em] text-ink";
const H3 = "mb-2 mt-6 text-[15px] font-semibold text-ink";
const P = "mb-3 text-[14px] leading-[1.65] text-neutral-600";
const LI = "text-[14px] leading-[1.65] text-neutral-600";
const CODE =
  "rounded-[4px] border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 font-mono text-[12.5px] text-ink";

function Pre({ children }: { children: string }) {
  return (
    <div className="mb-4 overflow-x-auto rounded-[8px] border border-neutral-200 bg-neutral-50">
      <pre className="p-4 font-mono text-[12.5px] leading-[1.6] text-neutral-700">{children}</pre>
    </div>
  );
}

export default function Msg91DocsPage() {
  return (
    <main className="mx-auto max-w-[820px] px-6 py-14">
      <p className="label-track mb-2 text-neutral-500">WHARF · Integration guide</p>
      <h1 className="text-[30px] font-bold tracking-[-0.02em] text-ink">
        Sending phone OTPs with MSG91
      </h1>
      <p className="mt-3 text-[15px] leading-[1.65] text-neutral-600">
        What you need to set up in MSG91 so a WHARF-managed Supabase instance can send phone
        verification codes, and what WHARF does with it once you have.
      </p>

      <div className={`${CARD} mt-8`}>
        <p className="mb-2 text-[14px] font-semibold text-ink">The one thing to get right</p>
        <p className="m-0 text-[14px] leading-[1.65] text-neutral-600">
          MSG91 only <em>delivers</em> the code here. It does not generate or check it — Supabase
          Auth does both. So use a regular <strong>Flow / SMS template</strong>, not MSG91&apos;s
          OTP product. If you wire up MSG91&apos;s OTP API, it will issue its own code, the user
          will type that one, and Supabase will reject it as wrong.
        </p>
      </div>

      <h2 className={H2}>How the pieces fit</h2>
      <p className={P}>
        Supabase Auth (GoTrue) has built-in drivers for a handful of SMS providers, and MSG91 is
        not one of them. Rather than not supporting it, WHARF uses the extension point Supabase
        provides for exactly this — a <em>send-SMS hook</em>. The instance hands the code to WHARF,
        and WHARF talks to MSG91.
      </p>
      <Pre>{`  user signs up with a phone number
        │
        ▼
  ┌───────────────────┐   1. generates the code
  │  Supabase Auth    │   2. POSTs it to WHARF (signed)
  │  (your instance)  │
  └───────────────────┘
        │
        ▼
  ┌───────────────────┐   3. verifies the signature
  │   WHARF panel     │   4. calls the MSG91 Flow API
  │  (holds MSG91     │      with your credentials
  │   credentials)    │
  └───────────────────┘
        │
        ▼
      MSG91  ──────────▶  SMS arrives on the handset

  user types the code back into your app
        │
        ▼
  Supabase Auth verifies it   (MSG91 is not involved)`}</Pre>
      <p className={P}>
        Two consequences worth knowing before you choose MSG91 over Twilio:
      </p>
      <ul className="mb-4 ml-5 list-disc space-y-1.5">
        <li className={LI}>
          <strong>Your MSG91 credentials never leave the WHARF panel.</strong> They are not written
          into the instance&apos;s environment, so nobody with access to the database server can
          read them.
        </li>
        <li className={LI}>
          <strong>The panel has to be reachable when someone signs up.</strong> If WHARF is down,
          codes stop going out until it is back. Twilio, which Supabase talks to directly, has no
          such dependency.
        </li>
      </ul>

      <h2 className={H2}>What you need before you start</h2>
      <ol className="mb-4 ml-5 list-decimal space-y-1.5">
        <li className={LI}>An MSG91 account.</li>
        <li className={LI}>
          Your MSG91 <strong>Auth Key</strong> (MSG91 console → Settings → API / Auth Key).
        </li>
        <li className={LI}>
          For Indian numbers: <strong>DLT registration</strong> — an approved entity, a sender
          header, and an approved content template. This is a regulatory requirement, not an MSG91
          one, and approval takes time. Start it early.
        </li>
        <li className={LI}>
          A <strong>Flow</strong> in MSG91 built on that approved template, with a variable where
          the code goes.
        </li>
      </ol>

      <h2 className={H2}>Step 1 — Register on DLT (India only)</h2>
      <p className={P}>
        Indian telecom regulation requires commercial SMS to be pre-registered. You will need to
        register your business as an entity, register a 6-character sender header (for example{" "}
        <code className={CODE}>WHARFX</code>), and submit the exact wording of the message for
        approval. Approval typically takes a few working days. Sending outside India does not
        require this.
      </p>
      <p className={P}>
        The approved wording must include a placeholder for the code. Something like:
      </p>
      <Pre>{`Your verification code is ##OTP##. It is valid for 10 minutes.
Do not share this code with anyone.`}</Pre>

      <h3 className={H3}>Note the variable name</h3>
      <p className={P}>
        Whatever you call that placeholder — <code className={CODE}>OTP</code>,{" "}
        <code className={CODE}>CODE</code>, <code className={CODE}>VAR1</code> — write it down. You
        will type it into WHARF, and the two must match exactly. This is the single most common
        cause of a message arriving with a blank code.
      </p>

      <h2 className={H2}>Step 2 — Create the Flow in MSG91</h2>
      <p className={P}>
        In the MSG91 console, create a Flow from your approved DLT template. MSG91 will give it a{" "}
        <strong>Template ID</strong> (sometimes called a Flow ID) — a string like{" "}
        <code className={CODE}>65f1a2b3c4d5e6f7a8b9c0d1</code>. You need that ID.
      </p>

      <h2 className={H2}>Step 3 — Enter it all in WHARF</h2>
      <p className={P}>
        In the WHARF panel, open the database instance, then{" "}
        <strong>Auth Settings → Providers → Phone</strong>. Set <strong>SMS provider</strong> to{" "}
        <strong>MSG91</strong> and fill in:
      </p>
      <div className="mb-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-neutral-200 text-left">
              <th className="py-2 pr-4 font-semibold text-ink">Field</th>
              <th className="py-2 font-semibold text-ink">What to put in it</th>
            </tr>
          </thead>
          <tbody className="text-neutral-600">
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top font-medium text-ink">MSG91 auth key</td>
              <td className="py-2.5 align-top">Your account&apos;s Auth Key.</td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top font-medium text-ink">Template (flow) ID</td>
              <td className="py-2.5 align-top">The ID from step 2.</td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top font-medium text-ink">Sender ID</td>
              <td className="py-2.5 align-top">
                Your registered 6-character header. Leave blank if the template already pins one.
              </td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top font-medium text-ink">OTP template variable</td>
              <td className="py-2.5 align-top">
                The placeholder name from step 1 — <code className={CODE}>OTP</code> in the example
                above. Must match exactly.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 className={H3}>Then turn off auto-confirm</h3>
      <p className={P}>
        In the same Phone section, switch <strong>off</strong> &ldquo;Auto-confirm phone sign-ups
        (skip the verification SMS)&rdquo;. While that is on, Supabase marks the number confirmed
        immediately and never sends anything — your MSG91 setup will look broken when it is
        actually just being bypassed.
      </p>
      <p className={P}>
        Finally press <strong>Save &amp; restart auth</strong>. The instance picks up the change on
        restart; nothing takes effect until you do.
      </p>

      <h2 className={H2}>Exactly what WHARF sends to MSG91</h2>
      <p className={P}>
        Useful for matching against your Flow, or for checking MSG91&apos;s delivery logs when
        something is not arriving.
      </p>
      <Pre>{`POST https://control.msg91.com/api/v5/flow/
authkey: <your auth key>
Content-Type: application/json

{
  "template_id": "<your template id>",
  "sender": "<your sender id>",       // omitted if you left it blank
  "short_url": "0",
  "recipients": [
    {
      "mobiles": "919999999999",      // digits only, country code, no "+"
      "OTP": "123456"                 // key = your OTP variable name
    }
  ]
}`}</Pre>
      <p className={P}>
        Note that <code className={CODE}>&quot;OTP&quot;</code> is not a fixed key — it is whatever
        you entered as the OTP template variable. That is the field MSG91 substitutes into your
        approved wording.
      </p>

      <h2 className={H2}>The webhook contract</h2>
      <p className={P}>
        You do not need this to use MSG91 with WHARF — it is handled for you. It is here if you are
        debugging the call, or building your own relay for a provider WHARF does not ship.
      </p>
      <p className={P}>
        Supabase Auth POSTs to the panel at{" "}
        <code className={CODE}>/api/db-instances/&lt;instance-id&gt;/sms-hook</code> with a body
        shaped like this:
      </p>
      <Pre>{`{
  "user": { ... },
  "sms": {
    "otp": "123456",
    "phone": "919999999999",
    "sms_type": "sms"
  }
}`}</Pre>

      <h3 className={H3}>Every call is signed</h3>
      <p className={P}>
        The endpoint is unauthenticated in the usual sense — Supabase Auth has no login session to
        present — so it is protected by a signature instead. An unsigned or wrongly signed request
        is rejected before anything is sent, because otherwise anyone who learned the URL could
        spend your SMS credit. Requests carry these headers, following the{" "}
        <a
          href="https://www.standardwebhooks.com/"
          className="text-cobalt-600 underline underline-offset-2 hover:text-cobalt-700"
          rel="noreferrer noopener"
          target="_blank"
        >
          Standard Webhooks
        </a>{" "}
        scheme:
      </p>
      <ul className="mb-4 ml-5 list-disc space-y-1.5">
        <li className={LI}>
          <code className={CODE}>webhook-id</code> — unique per message
        </li>
        <li className={LI}>
          <code className={CODE}>webhook-timestamp</code> — Unix seconds; anything more than 5
          minutes off is refused, so a captured request cannot be replayed later
        </li>
        <li className={LI}>
          <code className={CODE}>webhook-signature</code> — one or more{" "}
          <code className={CODE}>v1,&lt;signature&gt;</code> entries
        </li>
      </ul>
      <p className={P}>To verify one:</p>
      <Pre>{`secret  = value of GOTRUE_HOOK_SEND_SMS_SECRETS in the instance's .env
          (looks like "v1,whsec_AbCd...")

key     = base64_decode(secret without the leading "v1,whsec_")
signed  = webhook-id + "." + webhook-timestamp + "." + raw_request_body
expected= base64(hmac_sha256(key, signed))

accept if any "v1,<sig>" entry in webhook-signature equals expected`}</Pre>
      <p className={P}>
        Two things that trip people up: hash the <strong>raw body bytes</strong>, not a re-encoded
        version of the parsed JSON, and remember the key is the <em>base64-decoded</em> bytes rather
        than the string itself.
      </p>

      <h3 className={H3}>Responses</h3>
      <p className={P}>
        On success the panel returns <code className={CODE}>200</code> with an empty JSON object.
        Failures are deliberately terse, because Supabase surfaces them toward whoever is trying to
        sign in:
      </p>
      <div className="mb-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-neutral-200 text-left">
              <th className="py-2 pr-4 font-semibold text-ink">Status</th>
              <th className="py-2 font-semibold text-ink">Meaning</th>
            </tr>
          </thead>
          <tbody className="text-neutral-600">
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top font-mono text-[12.5px]">401</td>
              <td className="py-2.5 align-top">
                Signature missing, wrong, or timestamp outside the window.
              </td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top font-mono text-[12.5px]">404</td>
              <td className="py-2.5 align-top">No such instance.</td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top font-mono text-[12.5px]">409</td>
              <td className="py-2.5 align-top">
                The instance&apos;s SMS provider is not set to MSG91.
              </td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top font-mono text-[12.5px]">502</td>
              <td className="py-2.5 align-top">
                MSG91 refused the send. The reason is in the panel&apos;s server logs, not the
                response.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className={H2}>When it does not work</h2>
      <div className="mb-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-neutral-200 text-left">
              <th className="py-2 pr-4 font-semibold text-ink">Symptom</th>
              <th className="py-2 font-semibold text-ink">Almost always</th>
            </tr>
          </thead>
          <tbody className="text-neutral-600">
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top">Sign-up succeeds, no SMS arrives</td>
              <td className="py-2.5 align-top">
                Auto-confirm is still on, so no code was ever requested.
              </td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top">SMS arrives with a blank code</td>
              <td className="py-2.5 align-top">
                The OTP template variable in WHARF does not match the placeholder in your MSG91
                template.
              </td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top">Nothing sends, MSG91 logs show nothing</td>
              <td className="py-2.5 align-top">
                Wrong auth key, or the panel could not be reached from the database server.
              </td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top">
                MSG91 rejects with a template or DLT error
              </td>
              <td className="py-2.5 align-top">
                Template not approved yet, or the sender header is not registered against it.
              </td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top">The code is refused as invalid</td>
              <td className="py-2.5 align-top">
                MSG91&apos;s OTP product is generating its own code. Use a Flow template instead.
              </td>
            </tr>
            <tr className="border-b border-neutral-100">
              <td className="py-2.5 pr-4 align-top">Codes stop for a while, then resume</td>
              <td className="py-2.5 align-top">
                The panel was unreachable. Codes cannot be sent while it is down.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-10 border-t border-neutral-200 pt-5 text-[13px] text-neutral-500">
        MSG91 is a third-party service and its console, pricing and DLT requirements are theirs, not
        WHARF&apos;s — check their documentation for anything specific to your account.
      </p>
    </main>
  );
}
