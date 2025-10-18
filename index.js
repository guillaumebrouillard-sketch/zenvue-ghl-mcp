import express from "express";
import fetch from "node-fetch";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createTool } from "@modelcontextprotocol/sdk/tool/index.js";
import http from "http";

/**
 * GoHighLevel (LeadConnector) – pont MCP pour ChatGPT
 * Couvre:
 * - Contacts: champs natifs + vos champs personnalisés listés (General Info, Contact, Additional Info)
 * - Opportunités: champs natifs + vos champs personnalisés listés (Opportunity Details)
 * - Notes / Tâches / RDV
 *
 * ⚠️ Ne mettez AUCUNE clé ici. Tout passe par variables d’environnement Render:
 *   - GHL_API_KEY        (clé API du sous-compte)
 *   - LOCATION_ID        (id d’emplacement / location)
 *   - CONTACT_CODE_FIELD_KEY (optionnel) – clé du champ "Numéro client" pour recherche Cxxx
 *
 * L’API LeadConnector exige l’en-tête "Version: 2021-07-28".
 */

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

// ====== ENV VARS (définir sur Render → Environment) ======
const GHL_API_KEY = process.env.GHL_API_KEY;          // ex: eyJhbGciOiJI...
const LOCATION_ID = process.env.LOCATION_ID;          // ex: jp4bFrAx...
// Si tu veux qu’on recherche un contact par "Code client" (C266), configure la clé du champ.
// Par défaut on suppose ton champ: {{ contact.id_client }}  -> "contact.id_client"
const CONTACT_CODE_FIELD_KEY = process.env.CONTACT_CODE_FIELD_KEY || "contact.id_client";

if (!GHL_API_KEY || !LOCATION_ID) {
  console.error("Missing env: GHL_API_KEY or LOCATION_ID");
  process.exit(1);
}

// ---------- Vos clés de champs personnalisés (d’après ta liste) ----------
// CONTACT – General Info
const CONTACT_FIELDS_GENERAL = [
  "contact.company_name",           // Business Name
  "contact.address1",               // Street Address
  "contact.city",                   // City
  "contact.country",                // Country
  "contact.state",                  // State / Province
  "contact.postal_code",            // Postal Code
  "contact.website",                // Website
  "contact.timezone"                // Time Zone
];

// CONTACT – Contact (tes champs)
const CONTACT_FIELDS_CONTACT = [
  "contact.first_name",             // First Name
  "contact.last_name",              // Last Name
  "contact.email",                  // Email
  "contact.phone",                  // Phone
  "contact.date_of_birth",          // Date Of Birth
  "contact.source",                 // Contact Source
  "contact.type",                   // Contact Type
  "contact.summary_ai_conversation",// Summary AI Conversation (LARGE_TEXT)
  "contact.rsum_convo_ai",          // Résumé Phone AI (LARGE_TEXT)
  "contact.raison",                 // Raison (SINGLE_OPTIONS)
  "contact.prfrences_de_communication", // Préférences de communication (SINGLE_OPTIONS)
  "contact.id_client",              // ID_CLIENT (Numéro client)
  "contact.nombre_de_vitres",       // Nombre de Vitres (TEXT)
  "contact.google_sheets",          // Google Sheets (lien/ID sheet)
  "contact.brve_description_des_travaux_ex_nombre_de_portes_nombre_de_tiroirs_lot_approximatif_" // Brève description…
];

// CONTACT – Additional Info (tes champs)
const CONTACT_FIELDS_ADDITIONAL = [
  "contact.statut_client",                                                    // Statut client
  "contact.quel_est_le_principal_inconfort_que_vous_souhaitez_rgler_dans_votre_espace", // Radio
  "contact.combien_de_vitres_distinctes_souhaitezvous_traiter_",             // Radio
  "contact.dcriveznous_votre_problme_plus_en_dtail",                          // Large text
  "contact.tes_vous_dans_la_rgion_fb_form",                                   // FB FORM
  "contact.quel_est_le_principal_inconfort_que_vous_souhaitez_rgler_dans_votre_espace_facebook_form",
  "contact.quel_est_le_type_de_btiment__facebook_form",
  "contact.combien_de_vitres_distinctes_souhaitezvous_traiter__fb_form"
];

// OPPORTUNITY – Details (natifs + tes champs)
const OPP_NATIVE_KEYS = [
  "opportunity.name",               // Opportunity Name (NATIF)
  "opportunity.pipeline_id",        // Pipeline (NATIF)
  "opportunity.pipeline_stage_id",  // Stage (NATIF)
  "opportunity.status",             // Status (NATIF open/won/lost/abandoned/all)
  "opportunity.monetary_value",     // Lead Value (NATIF)
  "opportunity.assigned_to",        // Opportunity Owner (NATIF)
  "opportunity.source",             // Opportunity Source (NATIF)
  "opportunity.lost_reason"         // Lost Reason (NATIF)
];
// Tes champs custom sur opportunité
const OPP_CUSTOM_KEYS = [
  "opportunity.google_sheet_automation",  // CHECKBOX
  "opportunity.id_opportunit"             // TEXT
];

// Utilitaire: requêtes GHL
async function ghlFetch(path, { method = "GET", query = {}, body } = {}) {
  const url = new URL(path, GHL_BASE);
  // injecte locationId par défaut (utile/nécessaire sur plusieurs endpoints)
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

// ---------------- Helpers de construction de payloads ----------------
/**
 * Construit le body contact:
 * - mappe les champs "natifs" GHL (ex: firstName, lastName, email, phone…)
 * - ajoute TOUTES vos clés personnalisées (ci-dessus) en tant que customFields {key, value}
 * - supporte "customerCode" en plus (alias du champ contact.id_client)
 */
function buildContactBody(input) {
  // Champs natifs GHL (commande standard API)
  // NB: on accepte aussi "name", "companyName", "website", "timezone", "source"…
  const body = {
    locationId: LOCATION_ID,
    ...(input.firstName !== undefined && { firstName: input.firstName }),
    ...(input.lastName  !== undefined && { lastName: input.lastName }),
    ...(input.name      !== undefined && { name: input.name }),
    ...(input.email     !== undefined && { email: input.email }),
    ...(input.phone     !== undefined && { phone: input.phone }),
    ...(input.companyName !== undefined && { companyName: input.companyName }),
    ...(input.website     !== undefined && { website: input.website }),
    ...(input.source      !== undefined && { source: input.source }),
    ...(input.address1    !== undefined && { address1: input.address1 }),
    ...(input.address2    !== undefined && { address2: input.address2 }),
    ...(input.city        !== undefined && { city: input.city }),
    ...(input.state       !== undefined && { state: input.state }),
    ...(input.postalCode  !== undefined && { postalCode: input.postalCode }),
    ...(input.country     !== undefined && { country: input.country }),
    ...(input.timezone    !== undefined && { timezone: input.timezone }),
    ...(input.assignedTo  !== undefined && { assignedTo: input.assignedTo }),
    ...(Array.isArray(input.tags) && input.tags.length ? { tags: input.tags } : {})
  };

  // Agrège toutes les clés custom contact que tu m’as données
  const ALL_CONTACT_KEYS = [
    ...CONTACT_FIELDS_GENERAL,
    ...CONTACT_FIELDS_CONTACT,
    ...CONTACT_FIELDS_ADDITIONAL
  ];

  const cf = [];

  // 1) Si input.customerCode fourni, alimente automatiquement contact.id_client
  if (input.customerCode) {
    cf.push({ key: CONTACT_CODE_FIELD_KEY, value: input.customerCode });
  }

  // 2) Mapper chaque clé custom si la valeur est fournie dans input.customValues
  //    (customValues: { "contact.company_name": "...", "contact.google_sheets": "..." , ...})
  if (input.customValues && typeof input.customValues === "object") {
    for (const key of ALL_CONTACT_KEYS) {
      if (key in input.customValues) {
        cf.push({ key, value: input.customValues[key] });
      }
    }
  }

  if (cf.length) body.customFields = cf;
  return body;
}

/**
 * Construit le body opportunité:
 * - mappe natifs: pipelineId, pipelineStageId, status, contactId, monetaryValue, assignedTo, name, source, lost_reason
 * - ajoute vos champs custom d’opportunité en {key, value}
 */
function buildOpportunityBody(input) {
  const body = {
    locationId: LOCATION_ID,
    ...(input.contactId         && { contactId: input.contactId }),
    ...(input.pipelineId        && { pipelineId: input.pipelineId }),
    ...(input.pipelineStageId   && { pipelineStageId: input.pipelineStageId }),
    ...(input.status            && { status: input.status }), // open|won|lost|abandoned|all
    ...(typeof input.monetaryValue === "number" && { monetaryValue: input.monetaryValue }),
    ...(input.assignedTo        && { assignedTo: input.assignedTo }),
    ...(input.name              && { name: input.name }),
    ...(input.source            && { source: input.source }),
    ...(input.lost_reason       && { lost_reason: input.lost_reason })
  };

  const cf = [];
  if (input.customValues && typeof input.customValues === "object") {
    // natifs "clé" → déjà pris ci-dessus ; ici on gère vos deux customs + tout autre si besoin
    for (const key of OPP_CUSTOM_KEYS) {
      if (key in input.customValues) {
        // Checkbox: accepter true/false ou "true"/"false"
        let val = input.customValues[key];
        if (key === "opportunity.google_sheet_automation") {
          if (typeof val === "string") val = (val.toLowerCase() === "true");
        }
        cf.push({ key, value: val });
      }
    }
    // Si tu ajoutes d'autres keys custom opportunité, elles seront aussi prises
    for (const [k, v] of Object.entries(input.customValues)) {
      if (!OPP_NATIVE_KEYS.includes(k) && !OPP_CUSTOM_KEYS.includes(k) && k.startsWith("opportunity.")) {
        cf.push({ key: k, value: v });
      }
    }
  }
  if (cf.length) body.customFields = cf;

  return body;
}

// ========================= TOOLS =========================

// A) Lister les custom fields disponibles (contact/opportunity/all) pour vérifier les keys/id
const listLocationCustomFields = createTool({
  name: "list_location_custom_fields",
  description: "Lister les custom fields de la location pour model=contact|opportunity|all",
  inputSchema: {
    type: "object",
    properties: { model: { type: "string", enum: ["contact", "opportunity", "all"], default: "all" } }
  },
  invoke: async ({ model = "all" }) =>
    ghlFetch(`/locations/${LOCATION_ID}/customFields`, { method: "GET", query: { model } })
});

// B) Lister contacts (recherche libre optionnelle)
const listContacts = createTool({
  name: "list_contacts",
  description: "Lister des contacts (query texte optionnelle).",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 20 },
      query: { type: "string" }
    }
  },
  invoke: async ({ limit = 20, query }) => {
    const params = { limit };
    if (query) params.query = query;
    return ghlFetch("/contacts/", { query: params });
  }
});

// C) Créer / MAJ un contact (TOUS vos champs)
const upsertContact = createTool({
  name: "upsert_contact_full",
  description:
    "Créer/MAJ un contact (champs natifs + TOUS vos champs custom). Utiliser 'customValues' pour les clés {{ contact.xxx }}",
  inputSchema: {
    type: "object",
    properties: {
      // natifs
      firstName: { type: "string" },
      lastName:  { type: "string" },
      name:      { type: "string" },
      email:     { type: "string" },
      phone:     { type: "string" },
      companyName:{ type: "string" },
      website:   { type: "string" },
      source:    { type: "string" },
      address1:  { type: "string" },
      address2:  { type: "string" },
      city:      { type: "string" },
      state:     { type: "string" },
      postalCode:{ type: "string" },
      country:   { type: "string" },
      timezone:  { type: "string" },
      assignedTo:{ type: "string" },
      tags:      { type: "array", items: { type: "string" } },
      // alias pratique
      customerCode: { type: "string", description: "Numéro client (alias de contact.id_client)" },
      // tous vos custom fields contact par 'customValues': { 'contact.id_client': 'C266', ... }
      customValues: { type: "object" }
    }
  },
  invoke: async (input) => {
    const body = buildContactBody(input);
    return ghlFetch("/contacts/upsert", { method: "POST", body });
  }
});

// D) Trouver un contact par "Numéro client" (Cxxx)
const findContactByCustomerCode = createTool({
  name: "find_contact_by_customer_code",
  description: "Retrouver un contact via la clé configurée CONTACT_CODE_FIELD_KEY (par défaut contact.id_client).",
  inputSchema: { type: "object", required: ["customerCode"], properties: { customerCode: { type: "string" } } },
  invoke: async ({ customerCode }) => {
    const result = await ghlFetch("/contacts/", { query: { query: customerCode, limit: 100 } });
    const matches = (result.contacts || []).filter(c =>
      (c.customFields || []).some(cf =>
        cf.key === CONTACT_CODE_FIELD_KEY &&
        String(cf.value ?? "").trim() === String(customerCode).trim()
      )
    );
    return { matches };
  }
});

// E) Pipelines & stages
const listPipelines = createTool({
  name: "list_pipelines",
  description: "Lister pipelines et stages.",
  inputSchema: { type: "object", properties: {} },
  invoke: async () => ghlFetch("/opportunities/pipelines", {})
});

// F) Opportunités d’un contact
const listOpportunitiesByContact = createTool({
  name: "list_opportunities_by_contact",
  description: "Lister les opportunités liées à un contact (par contactId).",
  inputSchema: { type: "object", required: ["contactId"], properties: { contactId: { type: "string" } } },
  invoke: async ({ contactId }) =>
    ghlFetch("/opportunities/", { query: { contactId, limit: 100 } })
});

// G) Créer / MAJ une opportunité (natifs + vos customs)
const upsertOpportunity = createTool({
  name: "upsert_opportunity_full",
  description:
    "Créer/MAJ une opportunité. Fournir contactId, pipelineId, (pipelineStageId si nécessaire), name, + 'customValues' (ex: google_sheet_automation, id_opportunit).",
  inputSchema: {
    type: "object",
    required: ["contactId", "pipelineId", "name"],
    properties: {
      contactId:       { type: "string" },
      pipelineId:      { type: "string" },
      pipelineStageId: { type: "string" },
      status:          { type: "string", enum: ["open", "won", "lost", "abandoned", "all"] },
      monetaryValue:   { type: "number" },
      assignedTo:      { type: "string" },
      name:            { type: "string" },
      source:          { type: "string" },
      lost_reason:     { type: "string" },
      customValues:    { type: "object" } // ex: { "opportunity.google_sheet_automation": true, "opportunity.id_opportunit": "OPP-123" }
    }
  },
  invoke: async (input) => {
    const body = buildOpportunityBody(input);
    return ghlFetch("/opportunities/upsert", { method: "POST", body });
  }
});

// H) Ajouter une note dans une opportunité
const addOpportunityNote = createTool({
  name: "add_opportunity_note",
  description: "Ajouter une note (texte) à une opportunité.",
  inputSchema: {
    type: "object",
    required: ["opportunityId", "text"],
    properties: { opportunityId: { type: "string" }, text: { type: "string" } }
  },
  invoke: async ({ opportunityId, text }) =>
    ghlFetch(`/opportunities/${opportunityId}/notes`, { method: "POST", body: { text } })
});

// I) Créer une tâche (rappel) liée à une opportunité
const createOpportunityTask = createTool({
  name: "create_opportunity_task",
  description: "Créer une tâche (rappel) liée à une opportunité.",
  inputSchema: {
    type: "object",
    required: ["opportunityId", "title", "dueDateTime"],
    properties: {
      opportunityId: { type: "string" },
      title:         { type: "string" },
      dueDateTime:   { type: "string", description: "ISO 8601 ex: 2025-08-26T06:30:00-04:00" },
      notes:         { type: "string" }
    }
  },
  invoke: async (input) =>
    ghlFetch(`/opportunities/${input.opportunityId}/tasks`, { method: "POST", body: input })
});

// J) Planifier un RDV (si calendrier actif)
const scheduleAppointment = createTool({
  name: "schedule_appointment",
  description: "Planifier un rendez-vous pour un contact (calendrier GHL).",
  inputSchema: {
    type: "object",
    required: ["contactId", "calendarId", "startDateTime", "endDateTime", "address"],
    properties: {
      contactId:     { type: "string" },
      calendarId:    { type: "string" },
      startDateTime: { type: "string" },
      endDateTime:   { type: "string" },
      address:       { type: "string" },
      notes:         { type: "string" }
    }
  },
  invoke: async (input) =>
    ghlFetch("/calendars/appointments", { method: "POST", body: input })
});

// --------------- Serveur MCP (SSE) ---------------
const tools = [
  listLocationCustomFields,
  listContacts,
  upsertContact,
  findContactByCustomerCode,
  listPipelines,
  listOpportunitiesByContact,
  upsertOpportunity,
  addOpportunityNote,
  createOpportunityTask,
  scheduleAppointment
];

const app = express();
const serverMCP = new Server({ name: "zenvue-ghl-mcp", version: "2.1.0", tools });

app.get("/sse", (req, res) => serverMCP.handleSSE(req, res));
app.get("/",  (req, res) => res.send("ZenVue GHL MCP OK"));

const port = process.env.PORT || 3000;
http.createServer(app).listen(port, () => console.log(`MCP listening on ${port}`));
