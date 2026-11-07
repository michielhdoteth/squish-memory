import { readFileSync } from 'fs';
const data = JSON.parse(readFileSync('benchmark/locomo10.json', 'utf-8'));
// Show first 3 adversarial questions with their indices
let count = 0;
for (let ci = 0; ci < data.length; ci++) {
  for (let qi = 0; qi < data[ci].qa.length; qi++) {
    const qa = data[ci].qa[qi];
    if (qa.category === 5 && count < 5) {
      console.log(`conv${ci}/q${qi}: Q="${qa.question}" adv_answer="${qa.adversarial_answer}"`);
      count++;
    }
  }
}
