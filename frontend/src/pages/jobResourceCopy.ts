import type { AppLanguage } from "../i18n";

export interface JobResourceCopy {
  title: string;
  none: string;
  allReady: string;
  notReady: string;
  estimated: string;
  actual: string;
  variance: string;
  unknown: string;
  requirementName: string;
  quantity: string;
  unit: string;
  estimatedCost: string;
  add: string;
  adding: string;
  added: string;
  type: string;
  name: string;
  status: string;
  setCost: string;
  actualCostPrompt: string;
  noPermission: string;
  loadError: string;
  addError: string;
  updateError: string;
  invalidCost: string;
  types: Record<string, string>;
  statuses: Record<string, string>;
}

const EN: JobResourceCopy = {
  title: "Materials and resources", none: "No resource requirements recorded.", allReady: "All recorded resources are ready.",
  notReady: "{notReady} of {total} resources are not ready.", estimated: "Estimated", actual: "Actual", variance: "Variance", unknown: "Unknown",
  requirementName: "Requirement name", quantity: "Quantity", unit: "Unit", estimatedCost: "Estimated cost", add: "Add", adding: "Adding…",
  added: "The material or resource was added to this job.", type: "Type", name: "Name", status: "Status", setCost: "Set cost",
  actualCostPrompt: "Actual cost", noPermission: "Your account may view resources but cannot add or change them.",
  loadError: "Could not load materials and resources.", addError: "The material or resource could not be added.",
  updateError: "The resource could not be updated.", invalidCost: "Enter a valid non-negative cost.",
  types: { material: "Material", equipment: "Equipment", vehicle: "Vehicle", hire: "Hire", waste: "Waste" },
  statuses: { needed: "Needed", ordered: "Ordered", ready: "Ready", unavailable: "Unavailable" },
};

export const JOB_RESOURCE_COPY: Record<AppLanguage, JobResourceCopy> = {
  "en-GB": EN,
  "en-US": EN,
  "cs-CZ": {
    title: "Materiály a zdroje", none: "Nejsou evidovány žádné požadavky na zdroje.", allReady: "Všechny evidované zdroje jsou připravené.",
    notReady: "{notReady} z {total} zdrojů není připraveno.", estimated: "Odhad", actual: "Skutečnost", variance: "Rozdíl", unknown: "Neznámé",
    requirementName: "Název požadavku", quantity: "Množství", unit: "Jednotka", estimatedCost: "Odhadované náklady", add: "Přidat", adding: "Přidávání…",
    added: "Materiál nebo zdroj byl přidán k této zakázce.", type: "Typ", name: "Název", status: "Stav", setCost: "Nastavit náklady",
    actualCostPrompt: "Skutečné náklady", noPermission: "Váš účet může zdroje zobrazit, ale nemůže je přidávat ani měnit.",
    loadError: "Materiály a zdroje se nepodařilo načíst.", addError: "Materiál nebo zdroj se nepodařilo přidat.",
    updateError: "Zdroj se nepodařilo aktualizovat.", invalidCost: "Zadejte platnou nezápornou částku.",
    types: { material: "Materiál", equipment: "Vybavení", vehicle: "Vozidlo", hire: "Pronájem", waste: "Odpad" },
    statuses: { needed: "Potřebné", ordered: "Objednané", ready: "Připravené", unavailable: "Nedostupné" },
  },
  "pl-PL": {
    title: "Materiały i zasoby", none: "Nie zapisano żadnych wymagań dotyczących zasobów.", allReady: "Wszystkie zapisane zasoby są gotowe.",
    notReady: "{notReady} z {total} zasobów nie jest gotowych.", estimated: "Szacowane", actual: "Rzeczywiste", variance: "Różnica", unknown: "Nieznane",
    requirementName: "Nazwa wymagania", quantity: "Ilość", unit: "Jednostka", estimatedCost: "Szacowany koszt", add: "Dodaj", adding: "Dodawanie…",
    added: "Materiał lub zasób został dodany do tego zlecenia.", type: "Typ", name: "Nazwa", status: "Status", setCost: "Ustaw koszt",
    actualCostPrompt: "Rzeczywisty koszt", noPermission: "Twoje konto może wyświetlać zasoby, ale nie może ich dodawać ani zmieniać.",
    loadError: "Nie udało się wczytać materiałów i zasobów.", addError: "Nie udało się dodać materiału lub zasobu.",
    updateError: "Nie udało się zaktualizować zasobu.", invalidCost: "Wprowadź prawidłowy koszt nie mniejszy niż zero.",
    types: { material: "Materiał", equipment: "Sprzęt", vehicle: "Pojazd", hire: "Wynajem", waste: "Odpady" },
    statuses: { needed: "Potrzebne", ordered: "Zamówione", ready: "Gotowe", unavailable: "Niedostępne" },
  },
  "fr-FR": {
    title: "Matériaux et ressources", none: "Aucun besoin en ressources n’est enregistré.", allReady: "Toutes les ressources enregistrées sont prêtes.",
    notReady: "{notReady} ressource(s) sur {total} ne sont pas prêtes.", estimated: "Estimé", actual: "Réel", variance: "Écart", unknown: "Inconnu",
    requirementName: "Nom du besoin", quantity: "Quantité", unit: "Unité", estimatedCost: "Coût estimé", add: "Ajouter", adding: "Ajout…",
    added: "Le matériau ou la ressource a été ajouté à cette intervention.", type: "Type", name: "Nom", status: "Statut", setCost: "Définir le coût",
    actualCostPrompt: "Coût réel", noPermission: "Votre compte peut consulter les ressources, mais ne peut pas les ajouter ni les modifier.",
    loadError: "Impossible de charger les matériaux et ressources.", addError: "Impossible d’ajouter le matériau ou la ressource.",
    updateError: "Impossible de mettre à jour la ressource.", invalidCost: "Saisissez un coût valide supérieur ou égal à zéro.",
    types: { material: "Matériau", equipment: "Équipement", vehicle: "Véhicule", hire: "Location", waste: "Déchets" },
    statuses: { needed: "Nécessaire", ordered: "Commandé", ready: "Prêt", unavailable: "Indisponible" },
  },
  "de-DE": {
    title: "Materialien und Ressourcen", none: "Es sind keine Ressourcenanforderungen erfasst.", allReady: "Alle erfassten Ressourcen sind bereit.",
    notReady: "{notReady} von {total} Ressourcen sind nicht bereit.", estimated: "Geschätzt", actual: "Tatsächlich", variance: "Abweichung", unknown: "Unbekannt",
    requirementName: "Bezeichnung", quantity: "Menge", unit: "Einheit", estimatedCost: "Geschätzte Kosten", add: "Hinzufügen", adding: "Wird hinzugefügt…",
    added: "Das Material oder die Ressource wurde diesem Auftrag hinzugefügt.", type: "Typ", name: "Name", status: "Status", setCost: "Kosten festlegen",
    actualCostPrompt: "Tatsächliche Kosten", noPermission: "Ihr Konto darf Ressourcen anzeigen, aber nicht hinzufügen oder ändern.",
    loadError: "Materialien und Ressourcen konnten nicht geladen werden.", addError: "Das Material oder die Ressource konnte nicht hinzugefügt werden.",
    updateError: "Die Ressource konnte nicht aktualisiert werden.", invalidCost: "Geben Sie gültige, nicht negative Kosten ein.",
    types: { material: "Material", equipment: "Ausrüstung", vehicle: "Fahrzeug", hire: "Miete", waste: "Abfall" },
    statuses: { needed: "Benötigt", ordered: "Bestellt", ready: "Bereit", unavailable: "Nicht verfügbar" },
  },
  "es-ES": {
    title: "Materiales y recursos", none: "No se han registrado necesidades de recursos.", allReady: "Todos los recursos registrados están preparados.",
    notReady: "{notReady} de {total} recursos no están preparados.", estimated: "Estimado", actual: "Real", variance: "Diferencia", unknown: "Desconocido",
    requirementName: "Nombre del requisito", quantity: "Cantidad", unit: "Unidad", estimatedCost: "Coste estimado", add: "Añadir", adding: "Añadiendo…",
    added: "El material o recurso se añadió a este trabajo.", type: "Tipo", name: "Nombre", status: "Estado", setCost: "Establecer coste",
    actualCostPrompt: "Coste real", noPermission: "Su cuenta puede ver los recursos, pero no puede añadirlos ni modificarlos.",
    loadError: "No se pudieron cargar los materiales y recursos.", addError: "No se pudo añadir el material o recurso.",
    updateError: "No se pudo actualizar el recurso.", invalidCost: "Introduzca un coste válido no negativo.",
    types: { material: "Material", equipment: "Equipo", vehicle: "Vehículo", hire: "Alquiler", waste: "Residuos" },
    statuses: { needed: "Necesario", ordered: "Pedido", ready: "Preparado", unavailable: "No disponible" },
  },
  "it-IT": {
    title: "Materiali e risorse", none: "Non sono stati registrati requisiti di risorse.", allReady: "Tutte le risorse registrate sono pronte.",
    notReady: "{notReady} risorse su {total} non sono pronte.", estimated: "Stimato", actual: "Effettivo", variance: "Scostamento", unknown: "Sconosciuto",
    requirementName: "Nome del requisito", quantity: "Quantità", unit: "Unità", estimatedCost: "Costo stimato", add: "Aggiungi", adding: "Aggiunta…",
    added: "Il materiale o la risorsa è stato aggiunto a questo lavoro.", type: "Tipo", name: "Nome", status: "Stato", setCost: "Imposta costo",
    actualCostPrompt: "Costo effettivo", noPermission: "Il tuo account può visualizzare le risorse, ma non può aggiungerle o modificarle.",
    loadError: "Impossibile caricare materiali e risorse.", addError: "Impossibile aggiungere il materiale o la risorsa.",
    updateError: "Impossibile aggiornare la risorsa.", invalidCost: "Inserisci un costo valido non negativo.",
    types: { material: "Materiale", equipment: "Attrezzatura", vehicle: "Veicolo", hire: "Noleggio", waste: "Rifiuti" },
    statuses: { needed: "Necessario", ordered: "Ordinato", ready: "Pronto", unavailable: "Non disponibile" },
  },
};

export function resourceReadiness(copy: JobResourceCopy, notReady: number, total: number) {
  return copy.notReady.replace("{notReady}", String(notReady)).replace("{total}", String(total));
}
