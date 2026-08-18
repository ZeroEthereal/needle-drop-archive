import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("the product exposes exactly the three requested primary destinations", async () => {
  const component = await source("app/components/MusicVault.tsx");
  const navBlock = component.match(/const navItems:[\s\S]*?= \[([\s\S]*?)\];/);

  assert.ok(navBlock, "primary navigation definition is present");
  assert.equal((navBlock[1].match(/id:\s*"/g) ?? []).length, 3);
  assert.match(navBlock[1], /id:\s*"recovery"[\s\S]*?label:\s*"待找回"/);
  assert.match(navBlock[1], /id:\s*"likes"[\s\S]*?label:\s*"歌单歌曲"/);
  assert.match(navBlock[1], /id:\s*"sync"[\s\S]*?label:\s*"同步状态"/);
  assert.doesNotMatch(navBlock[1], /history|历史/i);
});

test("the neon dashboard remains real-data-only and motion-aware", async () => {
  const [component, css, page, layout] = await Promise.all([
    source("app/components/MusicVault.tsx"),
    source("app/globals.css"),
    source("app/page.tsx"),
    source("app/layout.tsx"),
  ]);

  assert.match(component, /prefers-reduced-motion:\s*reduce/);
  assert.match(component, /immersive/);
  assert.match(component, /balanced/);
  assert.match(component, /static/);
  assert.match(component, /\/api\/recovery/);
  assert.match(component, /\/api\/likes/);
  assert.match(component, /\/api\/sync\/status/);
  assert.match(component, /notify\("已处理", "good"\)/);
  assert.doesNotMatch(component, /CompletionModal|确认已找回/);
  assert.doesNotMatch(component, /className=\{`toast[\s\S]*?<button/);
  assert.match(component, /已消失/);
  assert.match(component, /qrImageUrl/);
  assert.doesNotMatch(component, /codekey|QRCode\.toDataURL/);
  assert.doesNotMatch(component, /mockSongs|demoSongs|sampleTracks|演示歌曲/);
  assert.match(css, /min-height:\s*44px|height:\s*44px/);
  assert.match(`${component}\n${layout}`, /拾针/);
  assert.match(layout, /\/og\.png/);
  assert.doesNotMatch(`${component}\n${page}`, /SkeletonPreview|Codex is working/);
});
