const fs = require('fs');
const content = fs.readFileSync('app/wallet/page.tsx', 'utf8');

// The BADGE_ICONS const needs to be declared BEFORE BadgeIcon function
// Currently it's missing from the file entirely or in wrong position
// Check if it exists
if (!content.includes('const BADGE_ICONS:')) {
  console.error('BADGE_ICONS not in file at all');
  process.exit(1);
}
if (!content.includes('function BadgeIcon(')) {
  console.error('BadgeIcon function not found');
  process.exit(1);
}

// Move BADGE_ICONS to just before BadgeIcon function
// First extract it
const iconsStart = content.indexOf('const BADGE_ICONS:');
let depth = 0, iconsEnd = iconsStart, found = false;
for (let i = iconsStart; i < content.length; i++) {
  if (content[i] === '{') { depth++; found = true; }
  if (content[i] === '}') depth--;
  if (found && depth === 0) { iconsEnd = i + 1; break; }
}
const iconsBlock = content.slice(iconsStart, iconsEnd);
console.log('Found BADGE_ICONS block:', iconsBlock.slice(0, 60) + '...');

// Remove it from current location (plus any surrounding newlines)
let withoutIcons = content.slice(0, iconsStart).trimEnd() + '\n' + content.slice(iconsEnd).trimStart();

// Insert it just before BadgeIcon function
const badgeIconFnIdx = withoutIcons.indexOf('function BadgeIcon(');
withoutIcons = withoutIcons.slice(0, badgeIconFnIdx) + iconsBlock + '\n' + withoutIcons.slice(badgeIconFnIdx);

fs.writeFileSync('app/wallet/page.tsx', withoutIcons, 'utf8');
console.log('Fixed. Lines:', withoutIcons.split('\n').length);
