import { expect, test } from "vitest";
import { rewriteCssUrls } from "./css-urls.js";

const BASE = "http://example.com/assets/main.css";

/** Records every URL passed to inline; returns `data:inlined:<url>` unless mapped to null. */
function recordingInliner(nullFor: string[] = []) {
  const calls: string[] = [];
  const inline = async (absoluteUrl: string): Promise<string | null> => {
    calls.push(absoluteUrl);
    return nullFor.includes(absoluteUrl) ? null : `data:inlined:${absoluteUrl}`;
  };
  return { inline, calls };
}

test("resolves relative urls against baseUrl", async () => {
  const { inline, calls } = recordingInliner();
  const out = await rewriteCssUrls("body{background:url(img/dot.png)}", BASE, inline);
  expect(calls).toEqual(["http://example.com/assets/img/dot.png"]);
  expect(out).toBe('body{background:url("data:inlined:http://example.com/assets/img/dot.png")}');
});

test("inlines absolute same-origin urls", async () => {
  const { inline, calls } = recordingInliner();
  const out = await rewriteCssUrls(
    "div{background:url(http://example.com/x.png)}",
    BASE,
    inline,
  );
  expect(calls).toEqual(["http://example.com/x.png"]);
  expect(out).toBe('div{background:url("data:inlined:http://example.com/x.png")}');
});

test("handles single-quoted, double-quoted, and unquoted url tokens", async () => {
  const { inline, calls } = recordingInliner();
  const out = await rewriteCssUrls(
    "a{background:url('a.png')} b{background:url(\"b.png\")} c{background:url(c.png)}",
    BASE,
    inline,
  );
  expect(calls).toEqual([
    "http://example.com/assets/a.png",
    "http://example.com/assets/b.png",
    "http://example.com/assets/c.png",
  ]);
  expect(out).toBe(
    'a{background:url("data:inlined:http://example.com/assets/a.png")} ' +
      'b{background:url("data:inlined:http://example.com/assets/b.png")} ' +
      'c{background:url("data:inlined:http://example.com/assets/c.png")}',
  );
});

test("skips data: URIs without calling inline", async () => {
  const { inline, calls } = recordingInliner();
  const css = "div{background:url(data:image/png;base64,AAAA)}";
  const out = await rewriteCssUrls(css, BASE, inline);
  expect(calls).toEqual([]);
  expect(out).toBe(css);
});

test("skips cross-origin urls without calling inline", async () => {
  const { inline, calls } = recordingInliner();
  const css = "div{background:url(https://cdn.other.com/x.png)}";
  const out = await rewriteCssUrls(css, BASE, inline);
  expect(calls).toEqual([]);
  expect(out).toBe(css);
});

test("leaves the token untouched when inline returns null", async () => {
  const { inline, calls } = recordingInliner(["http://example.com/assets/missing.png"]);
  const css = "div{background:url(missing.png)}";
  const out = await rewriteCssUrls(css, BASE, inline);
  expect(calls).toEqual(["http://example.com/assets/missing.png"]);
  expect(out).toBe(css);
});

test("rewrites multiple urls in one css text, preserving surrounding text", async () => {
  const { inline, calls } = recordingInliner(["http://example.com/assets/fail.png"]);
  const css = [
    "@font-face{font-family:F;src:url(font.ttf)}",
    "h1{background:url(data:image/gif;base64,BB)}",
    "p{background:url('img/a.png') no-repeat, url(https://other.com/b.png)}",
    "div{background:url(fail.png)}",
  ].join("\n");
  const out = await rewriteCssUrls(css, BASE, inline);
  expect(calls).toEqual([
    "http://example.com/assets/font.ttf",
    "http://example.com/assets/img/a.png",
    "http://example.com/assets/fail.png",
  ]);
  expect(out).toBe(
    [
      '@font-face{font-family:F;src:url("data:inlined:http://example.com/assets/font.ttf")}',
      "h1{background:url(data:image/gif;base64,BB)}",
      'p{background:url("data:inlined:http://example.com/assets/img/a.png") no-repeat, url(https://other.com/b.png)}',
      "div{background:url(fail.png)}",
    ].join("\n"),
  );
});
