const fs = require('fs');
const path = require('path');

const JSON_DIR = path.resolve(__dirname, '../json');
const SUMMARY_DIR = path.join(JSON_DIR, 'summary');

function readAll(type) {
  const file = path.join(JSON_DIR, `${type}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

if (!fs.existsSync(SUMMARY_DIR)) fs.mkdirSync(SUMMARY_DIR, { recursive: true });

const resources = readAll('resource');
const policies  = readAll('policy');
const actions   = readAll('action');

const actionMap = {};
for (const a of actions) {
  if (a.slug) actionMap[a.slug] = a;
}

let total = 0;

for (const resource of resources) {
  const resourceSlug = resource.slug || resource.collection_name;
  if (!resourceSlug) continue;

  // Policies belonging to this resource
  const resourcePolicies = policies.filter((p) => {
    const pRes = Array.isArray(p.resource) ? p.resource : [p.resource];
    return pRes.includes(resourceSlug);
  });

  // Gom theo role
  const roleMap = {};
  for (const p of resourcePolicies) {
    const roles = Array.isArray(p.role) ? p.role : [p.role].filter(Boolean);
    const pActions = (Array.isArray(p.action) ? p.action : [p.action]).filter(Boolean);

    for (const role of roles) {
      if (!roleMap[role]) roleMap[role] = { slug: role, actions: {} };

      for (const actionSlug of pActions) {
        if (!roleMap[role].actions[actionSlug]) {
          roleMap[role].actions[actionSlug] = {
            ...actionMap[actionSlug] || { slug: actionSlug },
            policies: [],
          };
        }
        const { action: _a, resource: _r, role: _ro, ...policyRest } = p;
        roleMap[role].actions[actionSlug].policies.push(policyRest);
      }
    }
  }

  // Convert map → array
  const summary = {
    ...resource,
    roles: Object.values(roleMap).map((r) => ({
      slug: r.slug,
      actions: Object.values(r.actions),
    })),
  };

  const filePath = path.join(SUMMARY_DIR, `${resourceSlug}.json`);
  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`✓ ${resourceSlug}.json — ${Object.keys(roleMap).length} roles`);
  total++;
}

console.log(`\nDone: ${total} files → backend/json/summary/`);
