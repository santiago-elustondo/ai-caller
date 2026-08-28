import { placeCall } from './twilio.js';

const phoneNumber = process.argv[2];

if (!phoneNumber) {
  console.error('Usage: npm run call -- <E.164-number>');
  console.error('Example: npm run call -- +14165551234');
  process.exit(1);
}

// Basic E.164 sanity check
if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
  console.error(`Invalid phone number: ${phoneNumber}`);
  console.error('Must be in E.164 format, e.g. +14165551234');
  process.exit(1);
}

console.log(`Calling ${phoneNumber}...`);

placeCall(phoneNumber)
  .then((sid) => {
    console.log(`call created — Twilio Call SID: ${sid}`);
    console.log('Watch the server logs to track call progress.');
  })
  .catch((err) => {
    console.error('Failed to place call:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
