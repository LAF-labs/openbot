import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { t } from "@/lib/i18n";

/**
 * "By continuing you agree to the terms and the privacy policy", with the two nouns as links.
 *
 * ONE SENTENCE, SPLIT AFTER TRANSLATION. The English and the Korean put the two documents in the
 * same order but in different frames — "agree to the X and the Y" against "X과 Y에 동의" — so the
 * links cannot be stitched from three translated fragments without one language reading wrong.
 * The dictionary holds the whole sentence with two placeholders, and this splits the translated
 * result on them, so the Korean josa (약관**과**) lives in the dictionary where it belongs.
 */
const SENTENCE = () =>
  t("By continuing you agree to the {terms} and the {privacy}.");

const LINK_CLASS = "underline underline-offset-2 hover:no-underline";

export function ConsentLine({ className }: { className?: string }) {
  const parts = SENTENCE().split(/(\{terms\}|\{privacy\})/);
  return (
    <p className={className}>
      {parts.map((part, index) => {
        // Index as the key is right here: the parts are positions in one fixed sentence.
        const key = `${index}:${part}`;
        if (part === "{terms}") {
          return (
            <Link className={LINK_CLASS} key={key} to="/legal/terms">
              {t("Terms of Service")}
            </Link>
          );
        }
        if (part === "{privacy}") {
          return (
            <Link className={LINK_CLASS} key={key} to="/legal/privacy">
              {t("Privacy Policy")}
            </Link>
          );
        }
        return <Fragment key={key}>{part}</Fragment>;
      })}
    </p>
  );
}
