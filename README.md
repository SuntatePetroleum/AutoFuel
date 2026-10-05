# Fuel Scheduler

Forecasts when each service station tank will run low and plans tanker deliveries.
This first part is the setup app: sites, tanks, trucks with compartments, grades,
terminals, drivers, users, company settings, and an import from the setup spreadsheet.

It runs as one Cloudflare Worker with a D1 database. The app creates and upgrades its
own tables on first use, so there is no separate database step after deploying.

## Deploy (Cloudflare + GitHub)

1. **Create the database.** Cloudflare dashboard → Storage & databases → D1 →
   Create. Name it `fuel-scheduler` and copy its Database ID.
2. **Add the database ID.** In `wrangler.toml`, replace
   `PASTE-YOUR-D1-DATABASE-ID-HERE` with that ID.
3. **Put the code on GitHub.** Create an empty private repository and upload
   everything in this folder (keep the folder structure).
4. **Connect it to Cloudflare.** Workers & Pages → Create → Import a repository →
   pick the repository. Keep the Worker name `fuel-scheduler` (it must match
   `wrangler.toml`) and the deploy command `npx wrangler deploy`. Deploy.
5. **Open the app** at the workers.dev address Cloudflare shows. The first screen
   creates your company and admin account, then takes you to Import.

Every push to the repository redeploys the app.

## Accounts and roles

- **Admin:** changes setup data and settings, adds users, imports spreadsheets.
- **Dispatcher:** sees all setup data, can't change it.
- **Driver:** signs in; driver screens come in a later part.

Every record belongs to one company, and every query is limited to the signed-in
user's company.

## Importing setup data

Import → choose the setup spreadsheet (.xlsx). The app reads the Sites, Tanks,
Trucks, Compartments and Grades tabs, shows a preview, and saves nothing until you
confirm. Rows are matched by name, blank cells leave existing values alone, and each
truck on the Compartments tab gets exactly the compartments listed. If any row has a
problem, nothing is imported and the problems are listed.

## Tank limits

Set in Settings, for the whole company:

- **Safe fill limit** (default 95%): the most a delivery may fill any tank to.
- **Lowest level** (default 1 day of sales): each tank's floor is this many days of
  its own average sales. It is calculated once sales are uploaded.
- **Never below** (default 5% of capacity): a minimum floor for slow-selling tanks.

## Run it on your own computer

Needs Node.js 22 or later. No packages to install.

```
node dev/server.mjs 8787 dev.sqlite
```

Then open http://localhost:8787. `dev/server.mjs` runs the Worker with a local
SQLite file in place of D1.

## Files

- `src/index.js`: the Worker, with the database schema, login, API and import.
- `src/ui.html`: the whole app screen (HTML, styles and script in one file).
- `dev/`: the local test server.

To change the database later, add a new entry to the end of `MIGRATIONS` in
`src/index.js`; never edit an existing entry.
