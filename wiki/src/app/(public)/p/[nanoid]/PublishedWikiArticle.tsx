"use client";

import type { CSSProperties } from "react";
import { T, FONT } from "@/lib/typography";
import { WikiInfobox } from "@/components/wiki/WikiInfobox";
import { MarkdownContent } from "@/components/wiki/MarkdownContent";
import type {
  WikiInfobox as WikiInfoboxData,
  WikiRef,
} from "@/lib/sidecarTypes";

export interface PublishedWikiData {
  name: string;
  type: string;
  publishedAt: string;
  content: string;
  refs?: Record<string, WikiRef>;
  infobox?: WikiInfoboxData | null;
}

const bodyStyle: CSSProperties = {
  ...T.bodySmall,
  color: "var(--wiki-article-text)",
};

export function PublishedWikiArticle({ wiki }: { wiki: PublishedWikiData }) {
  const publishedDate = new Date(wiki.publishedAt).toLocaleDateString(
    "en-US",
    { year: "numeric", month: "long", day: "numeric" },
  );

  // Tiptap-saved bodies are HTML strings (start with `<`); markdown bodies
  // are LLM-emitted prose. ReactMarkdown escapes raw HTML, so an HTML body
  // routed through `<MarkdownContent>` renders as literal `&lt;p&gt;` text.
  // Mirror the shell page's `isHtmlBody` branch: HTML body short-circuits to
  // `dangerouslySetInnerHTML` (#253). The body is server-side authored and
  // already trusted (Tiptap save endpoint or AI generation).
  const isHtmlBody =
    typeof wiki.content === "string" && wiki.content.trim().startsWith("<");

  return (
    <div className="published-page">
      <header className="published-header">
        <span
          style={{
            ...T.bodySmall,
            fontWeight: 500,
            color: "var(--heading-color)",
          }}
        >
          Robin Wiki
        </span>
      </header>

      <article className="published-article">
        <h1
          style={{
            ...T.h1,
            fontFamily: FONT.SERIF,
            color: "var(--heading-color)",
            margin: 0,
          }}
        >
          {wiki.name}
        </h1>
        <p
          style={{
            ...T.micro,
            color: "var(--wiki-count)",
            marginTop: 4,
            marginBottom: 24,
          }}
        >
          Published {publishedDate}
        </p>

        {wiki.infobox && (
          <WikiInfobox
            title={wiki.name}
            image={wiki.infobox.image?.url}
            caption={wiki.infobox.caption}
            sections={[
              {
                rows: wiki.infobox.rows.map((row) => ({
                  key: row.label,
                  value: row.value,
                })),
              },
            ]}
          />
        )}

        {isHtmlBody ? (
          <div
            className="wiki-richtext-rendered"
            style={bodyStyle}
            dangerouslySetInnerHTML={{ __html: wiki.content }}
          />
        ) : (
          <MarkdownContent
            content={wiki.content}
            refs={wiki.refs}
            style={bodyStyle}
          />
        )}
      </article>

      <footer className="published-footer">
        <span style={{ ...T.micro, color: "var(--wiki-count)" }}>
          Powered by Robin Wiki
        </span>
      </footer>
    </div>
  );
}
