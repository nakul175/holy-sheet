import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(process.cwd(), "components/holy-sheet-app.tsx"), "utf8");
const css = readFileSync(join(process.cwd(), "app/workspace.css"), "utf8");

it("keeps only Share and the grouped document action menu in primary chrome", () => {
  expect(app).toContain('aria-label="Page options"');
  expect(app).toContain('<span className="menu-label">Content</span>');
  expect(app).toContain('<span className="menu-label">Governance</span>');
  expect(app).toContain('<span className="menu-label">Integrations</span>');
  expect(app.indexOf('className="share-primary"')).toBeLessThan(app.indexOf('className="page-tools"'));
  expect(css).toContain('.page-primary-actions > :not(.share-primary):not(.page-tools) { display:none; }');
  expect(css).toContain('.page-personal-actions > button { display:none; }');
  expect(css).toContain('.page-io-actions { display:none; }');
});

it("puts the approved actions in their menu groups", () => {
  const content = app.indexOf('<span className="menu-label">Content</span>');
  const governance = app.indexOf('<span className="menu-label">Governance</span>');
  const integrations = app.indexOf('<span className="menu-label">Integrations</span>');
  expect(content).toBeGreaterThan(-1);
  expect(app.indexOf('Import a document', content)).toBeLessThan(governance);
  expect(app.slice(governance, integrations)).toContain('ref={setGovernanceTarget}');
  expect(app.indexOf('Document bundles', integrations)).toBeGreaterThan(integrations);
  expect(app.indexOf('Create SHO task', integrations)).toBeGreaterThan(integrations);
});
