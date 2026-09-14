# Agent's Marketing Hub

I am building an AI marketing platform for real estate agents called Your Marketing Dude. I already have three working apps and an existing Supabase database. I need you to build a unified platform that wraps all three into one authenticated experience.

What already exists:

Content Generator app (live at lovely-cactus-733e4c.netlify.app) — generates monthly social posts, emails, and video scripts in an agent's voice

Voice DNA app (live at bejewelled-dusk-94cf27.netlify.app) — a 15-question voice interview that captures an agent's personality and communication style

SOI Database Builder (live at frabjous-gingersnap-632ba7.netlify.app) — cleans and segments a real estate agent's contact database into marketing lists

Existing Supabase project with tables: agents, generated_posts, feedback_history, agent_photos

What I need you to build:
A unified authenticated dashboard at one URL where a user logs in once and sees all three tools. The navigation should be:

Home

Build My Database (SOI Builder)

My Voice DNA (Voice DNA interview)

Monthly Marketing (Content Generator)

Account

The core concept:
Every module shares one agent profile — Voice DNA, photos, feedback history, and preferences all feed into one brain that gets smarter every month. This is a $97/month SaaS product for real estate agents.

Start with:
Build the authenticated shell — login, signup, and the main dashboard with navigation to the three modules. Connect to my existing Supabase project for auth. Keep the design clean, professional, and simple. The brand is Your Marketing Dude.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://marketing-dude-hq.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/8e61f194-23d9-49f2-bb29-74a8436dc899).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
