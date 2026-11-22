# Connect Gemini, Tiger Data, and Vultr

Rendering works without these accounts. This guide connects the optional services and explains how to verify them; it does not mean they are already configured or live. Provider information was checked on November 21, 2026.

## 1. Prepare your local settings

Open a terminal in this project's folder. You need Node.js 22.9 or newer and the installed dependencies described in [README.md](README.md#run-locally).

Create `.env` only if it does not already exist, then restrict access to it:

```sh
test -f .env || cp .env.example .env
chmod 600 .env
```

Open `.env` in your text editor. Keep this file local: it is excluded from Git. Put secrets in the editor, not in chat, screenshots, frontend code, or terminal commands. Leave `PUBLIC_URL` and `DOMAIN` blank for local setup.

## 2. Get a Gemini API key

1. Open [Google AI Studio's API keys page](https://aistudio.google.com/apikey) and sign in with your Google account.
2. Complete the account setup. Copy the default API key if one was created, or choose **Create API key** and select/create a project.
3. In `.env`, replace the `GEMINI_API_KEY` line with your key. Keep the model line as shown:

   ```dotenv
   GEMINI_API_KEY="PASTE_YOUR_KEY_HERE"
   GEMINI_MODEL=gemini-3.8-flash
   ```

New accounts start on the Free Tier, and this model has free input/output tokens within that tier's limits. Some projects require verification. You can see your actual quota in [AI Studio's rate-limit dashboard](https://aistudio.google.com/rate-limit). Enabling billing changes the cost arrangement; you can keep this demo on the Free Tier. [Key setup](https://aistudio.google.com/docs/api-key), [billing](https://aistudio.google.com/docs/billing), [model pricing](https://aistudio.google.com/docs/pricing#gemini-3.8-flash).

## 3. Create a free Tiger Data database

1. Sign up in [Tiger Console](https://console.cloud.tigerdata.com/signup).
2. Choose **New service**, then **Shared** compute, the documented free option. Keep TimescaleDB enabled, choose **Development**, and name the service `constellation`.
3. Check that the configuration summary shows a free/shared service, then create it. Wait until it is **Ready**.
4. Choose **Download the config** and save it privately. It contains the database password, which is shown only at creation.
5. Copy the complete PostgreSQL connection URL from that configuration into the `DATABASE_URL` line in `.env`:

   ```dotenv
   DATABASE_URL="PASTE_THE_COMPLETE_POSTGRESQL_URL_HERE"
   ```

Copy the URL itself, including its password and required TLS parameters; leave out any surrounding `psql` command. If you lose the password, reset it in the console. Connection details are under **Service info → Connect → More details**. [Create-service instructions](https://www.tigerdata.com/docs/get-started/quickstart/create-service), [connection details](https://www.tigerdata.com/docs/integrate/find-connection-details).

Tiger Data currently includes up to two free services, in beta. Their resources are limited, and reaching the storage cap makes a service read-only. The separate standard-service trial offers $1,000 in credits for 30 days with no card required; its credits expire and data may be removed afterward unless a payment method is added. Select Shared for this small demo and review the limits displayed in your account. [Free services and trial terms](https://www.tigerdata.com/docs/deploy/tiger-cloud/tiger-cloud-aws/pricing-and-account-management).

## 4. Verify the real services

Save `.env`, then run this from the project folder. The app server does not need to be running:

```sh
node --env-file-if-exists=.env scripts/verify-services.mjs
```

This makes a real Gemini request and validates the returned scene. It also initializes the configured database, writes one tagged test event, and checks the event and analytics by reading them back. It uses API quota and leaves the tagged database row for inspection.

Both services should report `"status": "verified"`, and the overall result should contain `"passed": true`. The sanitized report is saved to `artifacts/service-verification.json`. For Timescale functionality, check that the database result has `"timescaleHypertable": true`. Confirm in your Tiger Console that this is your Tiger-hosted service; PostgreSQL connectivity alone cannot prove the hosting provider.

To check just one integration:

```sh
node --env-file-if-exists=.env scripts/verify-services.mjs --gemini
node --env-file-if-exists=.env scripts/verify-services.mjs --database
```

`missing_configuration` means a required `.env` value is empty. For a Gemini failure, check the key, model access, and quota; HTTP 429 usually means a quota limit. For a database failure, check the complete URL, password, service readiness, and required TLS options.

Restart the running app or share launcher after editing `.env`, then test prompt-to-scene and render telemetry in the UI. A passing service check does not verify phones or a public deployment; use the [multi-device demo steps](README.md#first-multi-device-demo) for that.

## 5. Claim Vultr credits and deploy

The current [official MLH Vultr page](https://www.mlh.com/partners/vultr) offers **$100 in credits**:

1. Register through [MLH's Vultr credit form](https://mlh.link/vultr-discover). Students should enter their school name for Company and Student for Job Title.
2. Check your email and complete verification.
3. Create your account through [MLH's Vultr signup link](https://mlh.link/vultr-signup).
4. Enter the emailed promo under **Billing → Gift Code** and confirm the credited balance.

These are promotional credits, not a permanent free server. The current MLH page does not specify expiry or guarantee that a payment card is unnecessary. Check the redemption terms and the date shown in your account. Generic [Vultr signup instructions](https://docs.vultr.com/platform/create-an-account) require payment verification and advertise trial credits for up to 30 days; your MLH offer may differ. Resources can incur charges after credits expire or are exhausted. Stopping the app does not stop the server's bill: deprovision unused resources after saving any data you need.

Keep deployment credentials separate from the application's `.env`: store Vultr API tokens privately and SSH private keys in your SSH key store, such as `~/.ssh/`. The application does not need a Vultr API token. Deployment requires an authorized server, its IP address, SSH username/key, and a public hostname you control.

Follow [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md) for the proposed server, costs, DNS, HTTPS, deployment commands, and public verification. Confirm the chosen plan and spending limit before provisioning. Claiming credits alone does not deploy Constellation.
