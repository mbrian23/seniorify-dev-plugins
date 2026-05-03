// Integration tests REQUIRE a real Seniorify backend (Docker compose'd).
// Constitution §II forbids mocking the database / cross-process boundary in
// integration tests. Fail fast if the env var is missing — never silently
// skip, never substitute an in-memory fake.

const url = process.env.SENIORIFY_BACKEND_URL;

if (url === undefined || url.length === 0) {
  throw new Error(
    'SENIORIFY_BACKEND_URL is required for the integration workspace. ' +
      'Start the dockerized backend with `npm run backend:up` and export ' +
      'SENIORIFY_BACKEND_URL=http://localhost:<port> before running integration tests. ' +
      'Per Constitution §II, integration tests do NOT run against a mocked backend.',
  );
}
