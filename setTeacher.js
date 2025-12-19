const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

admin.auth().setCustomUserClaims('arf3kQ3xJrf87l1WOaXqOkLQuVa2', {
  role: 'teacher'
}).then(() => {
  console.log('✅ PROF OK');
  process.exit();
});
