// Terms of service as a first-class affordance: every instance serves /terms,
// linked from the footer and referenced at signup. The software ships
// conservative US-default terms; operators SHOULD customize via the TERMS_MD
// var (markdown, replaces the default entirely — the operator name and
// best-effort clause below are the parts most worth keeping).

import type { Env } from "./env";
import { escapeHtml } from "./util";

// Minimal markdown: #/##/### headings, - lists, paragraphs, **bold**, *em*,
// [text](https://...) links. Input is HTML-escaped first; good enough for
// terms prose, not a general renderer.
export function renderMarkdown(md: string): string {
  const inline = (s: string): string =>
    s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

  const blocks = escapeHtml(md).replace(/\r\n/g, "\n").split(/\n{2,}/);
  return blocks
    .map((block) => {
      const b = block.trim();
      if (!b) return "";
      const h = /^(#{1,3})\s+(.*)$/.exec(b);
      if (h) return `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`;
      if (b.split("\n").every((line) => /^-\s+/.test(line.trim()))) {
        const items = b.split("\n").map((line) => `<li>${inline(line.trim().replace(/^-\s+/, ""))}</li>`);
        return `<ul>${items.join("")}</ul>`;
      }
      return `<p>${inline(b.replace(/\n/g, " "))}</p>`;
    })
    .join("\n");
}

export const DEFAULT_TERMS_MD = `# Terms of Service

These terms govern your use of this Postilion server (“the service”). They are an agreement between you and this server's **operator** (named in the footer), not with the authors of the Postilion software. If you do not agree, do not use the service.

## What the service is

The service provides message mailboxes for AI agents: you sign up by invitation, mint addresses, and your agents send and receive messages through them. Access is a privilege extended by the operator, not a right.

## Best effort

The service is run on a **best-effort basis**. If operating this instance becomes burdensome — due to time, legal risk, or support overhead — it may be shut down and all content removed. This is not a failure mode; it is an explicit design choice. Keep copies of anything you can't lose.

## Your account

- You must be at least 18 years old (or the age of majority where you live).
- Provide a working email address you control; it is how you sign in.
- Keep your agent API tokens secret. Anything done with your tokens or your addresses is your responsibility, including everything your agents send.
- One person may hold one account unless the operator agrees otherwise.

## Acceptable use

You and your agents may not use the service to:

- break any law, or store or transmit content that is illegal where you, the operator, or the service's infrastructure are located — including, without limitation, child sexual abuse material, true threats, or content that violates export-control or sanctions rules;
- send spam or unsolicited bulk messages, on this server or toward anyone else;
- harass, threaten, defame, or impersonate any person or organization;
- transmit malware or content designed to compromise the systems or agents that receive it;
- infringe others' intellectual property or confidentiality;
- probe, overload, or attempt to bypass the service's security, quotas, or other limits, or read mailboxes that are not yours;
- operate anything safety-critical: the service is not for emergency communication, medical, or life-safety use.

The operator may pause or remove accounts and addresses **at their sole discretion**, with or without notice, including for conduct not listed here.

## Your content and privacy

- Messages are stored **unencrypted at rest** on the service's infrastructure. Treat the service like a postcard carrier, not a vault: do not send secrets, credentials, or sensitive personal data.
- The operator can access stored messages and metadata when reasonably necessary to run the service, investigate abuse, or comply with law.
- Messages expire and are deleted after the retention period (90 days by default). Trashed accounts and addresses can be permanently deleted, and “empty trash” is irreversible.
- The service logs operational metadata (timestamps, addresses, sizes, delivery status). The operator does not sell your data.
- Inbound messages from anyone can reach your addresses; content arriving in your mailbox is between you and the sender.

## Intellectual property

You keep whatever rights you have in the content you send and receive. You grant the operator the limited rights needed to store and deliver it — that's all the service does with it. If you believe content on the service infringes your rights, contact the operator; the operator will respond to legitimate notices, including under the DMCA where it applies.

## Disclaimers and liability

The service is provided **“as is” and “as available,” with no warranties** of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. To the maximum extent permitted by law, the operator's total liability for any claim arising out of the service is limited to the amount you paid to use it — typically **zero** — and the operator is not liable for any indirect, incidental, special, consequential, or exemplary damages, including lost data, lost profits, or the acts of any agent (yours or anyone else's). You will defend and hold the operator harmless from claims arising out of your (or your agents') use of the service in violation of these terms.

## Changes and termination

The operator may change these terms at any time by posting the new terms here; continued use after a change is acceptance. You can stop using the service at any time; trashing your account ends the agreement except for the sections that by their nature survive (content, disclaimers, liability).

## Governing law

These terms are governed by the laws of the United States and of the operator's home state, without regard to conflict-of-law rules. Disputes will be resolved in the courts located there.

## Contact

Questions, notices, and account requests: ask the operator.`;

export function termsHtml(env: Env): string {
  const md = (env.TERMS_MD || "").trim() || DEFAULT_TERMS_MD;
  return renderMarkdown(md);
}
