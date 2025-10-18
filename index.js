import express from "express";
import fetch from "node-fetch";
import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

// === Correctif v1.x : remplacer handleSSE par connect()
const createTool = (def) => def;

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const GHL_API_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.LOCATION_ID;

if (!GHL_API_KEY || !LOCATION_ID) {
  console.error("❌ Missing env: GHL_API_KEY or LOCATION_ID");
  process.exit(1);
}

// ---------- Helper pour requêtes LeadConnector ----------
async function ghlFetch(path, { method = "GET", query = {}, body } = {}) {
  const url = new URL(path, GHL_BASE);
  if (!("locationId" in query)) query.locationId = LOCATION_ID;
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  const res = await fetch(url.toString(), {
    method,
    headers: {
      "Authorization": `Bearer ${GHL_API_KEY}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Version": GHL_VERSION
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!res.ok) {
    throw new Error(`GHL ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ---------- Tools ----------
const listOpportunitiesByContact = createTool({
  name: "list_opportunities_by_contact",
  description: "Lister les opportunités d’un contact (par contactId).",
  inputSchema: {
    type: "object",
    required: ["contactId"],
    properties: { contactId: { type: "string" } }
  },
  invoke: async ({ contactId }) =>
    ghlFetch("/opportunities/", { query: { contactId, limit: 50 } })
});

const addOpportunityNote = createTool({
  name: "add_opportunity_note",
  description: "Ajouter une note dans une opportunité (champ Notes).",
  inputSchema: {
    type: "object",
    required: ["opportunityId", "text"],
    properties: {
      opportunityId: { type: "string" },
      text: { type: "string" }
    }
  },
  invoke: async ({ opportunityId, text }) =>
    ghlFetch(`/opportunities/${opportunityId}/notes`, {
      method: "POST",
      body: { text }
    })
});

const createOpportunityTask = createTool({
  name: "create_opportunity_task",
  description: "Créer une tâche (rappel) liée à une opportunité.",
  inputSchema: {
    type: "object",
    required: ["opportunityId", "title", "dueDateTime"],
    properties: {
      opportunityId: { type: "string" },
      title: { type: "string" },
      dueDateTime: { type: "string", description: "ISO ex: 2025-10-20T08:30:00-04:00" },
      notes: { type: "string" }
    }
  },
  invoke: async (input) =>
    ghlFetch(`/opportunities/${input.opportunityId}/tasks`, {
      method: "POST",
      body: input
    })
});

const scheduleAppointment = createTool({
  name: "schedule_appointment",
  description: "Planifier un rendez-vous pour un contact.",
  inputSchema: {
    type: "object",
    required: ["contactId", "calendarId", "startDateTime", "endDateTime", "address"],
    properties: {
      contactId: { type: "string" },
      calendarId: { type: "string" },
      startDateTime: { type: "string" },
      endDateTime: { type: "string" },
      address: { type: "string" },
      notes: { type: "string" }
    }
  },
  invoke: async (input) =>
    ghlFetch("/calendars/appointments", { method: "POST", body: input })
});

// ---------- Serveur MCP ----------
const tools = [
  listOpportunitiesByContact,
  addOpportunityNote,
  createOpportunityTask,
  scheduleAppointment
];

const app = express();
const serverMCP = new Server({ name: "zenvue-ghl-basic", version: "1.1.0", tools });

// ✅ Nouvelle version compatible du point /sse
app.get("/sse", async (req, res) => {
  const { connect } = await import("@modelcontextprotocol/sdk/server/connect.js");
  await connect({ req, res, server: serverMCP });
});

app.get("/", (req, res) => res.send("ZenVue GHL MCP OK (Basic Ops)"));

const port = process.env.PORT || 3000;
http.createServer(app).listen(port, () => console.log(`✅ MCP listening on ${port}`));
