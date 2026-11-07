import { readFileSync } from 'fs';
const data = JSON.parse(readFileSync('benchmark/locomo10.json', 'utf-8'));

// Check conversation structure
const conv = data[0];
console.log('Conv keys:', Object.keys(conv));
console.log('Conversation type:', typeof conv.conversation);
if (typeof conv.conversation === 'object') {
  console.log('Conversation keys:', Object.keys(conv.conversation).slice(0, 5));
}

// Search for sweden in all text
const allText = JSON.stringify(conv).toLowerCase();
const keywords = ['sweden', 'dinosaur', 'liberal', 'patriotic', 'shelter coordinator', 'counselor', 'mentoring'];
for (const kw of keywords) {
  const found = allText.includes(kw.toLowerCase());
  console.log(`${found ? 'FOUND' : 'MISSING'}: "${kw}" in conv0`);
}
