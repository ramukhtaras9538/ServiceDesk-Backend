# Service Desk API

## Environment and signing key

Copy `.env.example` to `.env` for local use. Keep `.env` out of version control and deployment artifacts. Generate a unique signing key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(64).toString('base64url'))"
```

Supply that value as `JWT_SECRET` through a secret manager in production. The API refuses to start with short, low-diversity, or known placeholder signing keys. Rotating the key invalidates all existing login tokens; rotate it immediately if it may have been exposed.

## MongoDB setup and SQLite migration

The API stores application records in MongoDB. Set `MONGODB_URI` and `MONGODB_DB` in the backend environment; keep Atlas credentials in a secret manager and never put them in the Expo app. The API reuses one MongoDB client, detects whether its server supports transactions, and creates the required indexes during startup. Replica sets and sharded clusters use transactions for multi-document writes. Standalone MongoDB servers are also supported, but those writes run without transaction atomicity and the API logs a warning; use MongoDB Atlas or a replica-set deployment when atomic multi-document writes are required. Monitor connection counts, pool checkout failures, wait time, and request latency under real traffic; keep the driver’s default pool sizing until measurements show a need to change it.

To preserve the existing SQLite data, set `SQLITE_SOURCE` to the existing database file and run from the backend directory:

```bash
npm run migrate:mongodb
```

The migration preserves numeric IDs and password hashes, copies ticket history and attachment files that are present in `UPLOAD_DIR`, and can be rerun without overwriting documents already in MongoDB. It does not modify or delete the SQLite database or uploaded files. Keep both as backups and verify the MongoDB data before retiring them. Missing local attachment files are reported and their metadata remains imported. New uploaded file contents and metadata are stored in MongoDB.

For a new MongoDB database, initialize the catalogs and create the first administrator with:

```bash
npm run seed
```

Before running the seed, set `INITIAL_ADMIN_EMP_ID`, `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_EMAIL`, and `INITIAL_ADMIN_PASSWORD` in the backend environment. Use a unique password of at least 12 characters and supply it through your deployment secret manager in production. The seed no longer creates shared sample user, agent, or administrator passwords. It creates the configured administrator only if that employee ID does not already exist, so rerunning the seed does not reset an existing password. After logging in, use **People and access** to create user and agent accounts.

If this database was seeded by an older version, change the password of every old sample account—especially `ADMIN`—before exposing the API publicly. The new seed does not replace passwords on existing accounts.

After configuring MongoDB and migrating or seeding, start the API with `npm run dev` or `npm start`. Work sessions started from the dashboard or Work record screen are stored in MongoDB per user; each account can have at most one active session.

## Login and password recovery

Login rejects an unknown employee ID or incorrect password with the same response; repeated `401` responses mean the credentials did not verify, not that the server can safely sign the user in. For seeded sample accounts, the seed script only creates missing users and does not overwrite existing passwords. Users can submit a password reset request from the login screen. The response does not disclose whether the account exists, and requests are rate limited. An administrator must verify the employee’s identity, open **People and access**, set a new password for the pending request, and communicate it privately. Protect administrator accounts and do not share passwords through public channels.

## Request catalog administration

Administrators can manage departments, categories, services, ticket priorities, and ticket statuses from the app's Request catalog screen. These choices are served dynamically by `GET /meta` and take effect in request creation, dashboard filters, and agent ticket updates. Catalog edits update ticket snapshots where applicable; deleting an option that is referenced by users, services, or tickets is rejected. The `open` and `resolved` statuses are reserved for ticket workflow behavior.

## Resolver ticket workflow

Agents (resolvers) can create tickets, assign tickets in their department to themselves or another department agent, and follow work by searching for a numeric ticket ID or ticket code. Automatic assignment selects the agent with the fewest unresolved tickets, with the stable user ID as a tie-breaker. Reassigning an already assigned ticket requires a 3–500 character explanation; the note is recorded in ticket history and included in notifications to the current and previous resolver.

Resolvers and administrators can create a linked ticket for a different department from a ticket they can access. The linked work is routed using the same least-loaded assignment rule, and the requesting and receiving teams are added as ticket participants so they can follow progress in their raised, assigned, or department dashboard queues. The dashboard has a dedicated linked-ticket section, and ticket detail pages show the parent and related department tickets. Dashboard, ticket detail, and administrator link status refresh automatically while open. The reason for the link appears in both ticket histories; the receiving resolver, relevant ticket participants, and administrators are notified of link creation and subsequent status, assignment, or comment updates. Administrators can review the source and linked ticket statuses, departments, link note, and ticket details in **People and access**.

## Resolver leave

Agents can open **Resolver leave** from the dashboard and schedule their own leave using `YYYY-MM-DD` dates. Administrators can review all scheduled, active, completed, or cancelled leave in the same screen and can cancel scheduled or active leave. The app sends in-app notifications when leave is scheduled, starts, is cancelled, or ends.

The API checks scheduled leave dates every minute. On the start date, each unresolved ticket assigned to the resolver is moved to the least-loaded available agent in that ticket's department. Requesters, administrators, the resolver on leave, and the covering agent receive in-app ticket notifications. Ticket lists and details identify the resolver who is away and show the covering resolver. If there is no available agent, the ticket remains assigned and administrators are notified that coverage is needed. Manual and automatic assignments exclude resolvers whose leave is active.

Unresolved covered tickets are returned to the original resolver after the leave end date. Resolved tickets keep their assignment history but no longer display the resolver as on leave. If an administrator cancels active leave, the same return behavior runs immediately. A manual reassignment during leave ends automatic coverage for that ticket, so the system does not overwrite the administrator's later decision. Consecutive leave periods preserve the original coverage relationship. Leave dates are interpreted as UTC calendar dates. Concurrent leave submissions for the same resolver are serialized, including when MongoDB is running without transaction support.

## Production transport

Terminate TLS at the API service or a trusted reverse proxy, and configure the client’s `EXPO_PUBLIC_API_URL` with that HTTPS origin. Set `CORS_ORIGINS` to a comma-separated list of exact HTTPS origins for the deployed web client (for example, `https://desk.example.com`). Production startup rejects a missing list, non-HTTPS origins, and URLs containing paths or query strings. Native clients do not send browser `Origin` headers and remain able to call the API; CORS is not an authentication control.

Never expose production login or bearer-token traffic over plain HTTP. Keep local `.env`, SQLite migration backups, and user data private and out of source control.
