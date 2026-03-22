import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";
const DB_PATH = process.env["CZ_COMP_DB_PATH"] ?? "data/uohs.db";
const force = process.argv.includes("--force");
const dir = dirname(DB_PATH);
if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log("Deleted " + DB_PATH);
}
const db = new Database(DB_PATH);
db.exec(SCHEMA_SQL);
const decisions = [
    { case_number: "UOHS-S0001/2024/KD", title: "Kartel dodavatelu stavebniho materialu", date: "2024-03-15", type: "cartel", sector: "retail", parties: "Stavebniny A, s.r.o.; Material B, a.s.; Distribuce C, s.r.o.", summary: "UOHS ulozil pokutu trim dodavatelum stavebniho materialu za kartelovou dohodu o rozdeleni trhu a koordinaci cen.", full_text: "Rozhodnuti UOHS UOHS-S0001/2024/KD\n\nTri dodavatele stavebniho materialu uzavreli kartelovou dohodu v rozporu s ZOHS a cl. 101 SFEU. Koordinovaly ceny a delily geograficke trhy po dobu 3 let, coz vedlo k umelemu zvyseni cen o 12-18%.\n\nSankce: 45 000 000 Kc.", outcome: "fine", fine_amount: 45000000, competition_articles: "ZOHS § 3, SFEU čl. 101", status: "final" },
    { case_number: "UOHS-S0002/2024/KD", title: "Zneuziti dominantniho postaveni na trhu distribuce zemniho plynu", date: "2024-05-22", type: "abuse_of_dominance", sector: "energy", parties: "Plynárenský distributor, a.s.", summary: "UOHS sankcionoval dominantniho distributora plynu za diskriminacni podminky vuci nezavislym dodavatelum.", full_text: "Rozhodnuti UOHS UOHS-S0002/2024/KD\n\nSpolecnost v dominantnim postaveni uplatnovala rozdilne technicke a obchodni podminky vuci nezavislym dodavatelum, cimz je vyslacova z trhu.\n\nSankce: 78 000 000 Kc a povinnost zavest transparentni podminky.", outcome: "fine", fine_amount: 78000000, competition_articles: "ZOHS § 11, SFEU čl. 102", status: "final" },
    { case_number: "UOHS-S0003/2024/KD", title: "Sektorizacni setreni mobilniho telekomunikacniho trhu", date: "2024-07-10", type: "sector_inquiry", sector: "telecommunications", parties: "Mobilni operatori pusobici na ceskem trhu", summary: "UOHS zahajil sektorove setreni trhu mobilnich telekomunikaci zamerenych na velkoobchodni ceny a podminy roamingu.", full_text: "Zahajeni sektoroveho setreni UOHS-S0003/2024/KD\n\nPredmet setreni:\n1. Velkoobchodni ceny za pristup k mobilnim sitim.\n2. Podminky MVNO.\n3. Roamingove dohody.\n4. Cenove chovani operatoru.", outcome: "ongoing", fine_amount: null, competition_articles: "ZOHS § 21b", status: "ongoing" },
    { case_number: "UOHS-S0004/2024/KD", title: "Koordinace cen farmaceutickych pripravku", date: "2024-09-05", type: "cartel", sector: "pharmaceuticals", parties: "Distributor leciv X, s.r.o.; Lekarenska sit Y, a.s.", summary: "UOHS zjistil zakkazanou dohodu o minimalnih maloobchodnich cenach OTC leciv.", full_text: "Rozhodnuti UOHS UOHS-S0004/2024/KD\n\nKoordinace RPM pro OTC leciva omezovala cenove soutezeni.\n\nSankce: 22 000 000 Kc.", outcome: "fine", fine_amount: 22000000, competition_articles: "ZOHS § 3", status: "final" },
    { case_number: "UOHS-S0005/2024/KD", title: "Nefer obchodni podminky online triste", date: "2024-11-20", type: "abuse_of_dominance", sector: "retail", parties: "Online trziste Z, a.s.", summary: "UOHS prijal zavazky od dominantni online trziste o odstraneni nefer smluvnich podminek vuci prodejcum.", full_text: "Rozhodnuti UOHS UOHS-S0005/2024/KD\n\nDominantni online trziste uplatnovala jednostranne menitelne podminky, nepmere poplatky a vyhradni prodej.\n\nPrijate zavazky: transparentni podminky, zakaz retroaktivnich poplatku, nezavisly mechanismus sporu.", outcome: "remedies", fine_amount: null, competition_articles: "ZOHS § 11", status: "final" },
];
const mergers = [
    { case_number: "UOHS-M0001/2024", title: "Spojeni supermarketu v maloobchodu s potravinami", date: "2024-04-18", sector: "retail", acquiring_party: "Supermarkety Alfa, a.s.", target: "Maloobchod Beta, s.r.o.", summary: "UOHS povolil spojeni dvou retezu supermarketu s podmínkami odprodeje prodejen ve trech regionech.", full_text: "Rozhodnuti UOHS UOHS-M0001/2024\n\nFuze by vedla k trznimu podilu pres 40 % ve trech krajich.\n\nPodminky: odprodej 12 prodejen v Jihomoravskem, Olomouckem a Zlinskem kraji.", outcome: "approved_with_conditions", turnover: null },
    { case_number: "UOHS-M0002/2024", title: "Prevzeti regionalniho telekomunikacniho operatora", date: "2024-06-30", sector: "telecommunications", acquiring_party: "Telekomunikace CZ, a.s.", target: "RegioNet, s.r.o.", summary: "UOHS povolil bez podminek akvizici regionalniho ISP s ohledem na omezeny trzni podil cile.", full_text: "Rozhodnuti UOHS UOHS-M0002/2024\n\nRegioNet ma trzni podil pod 5 %. Horizontalni prekryvy minimalni.\n\nZaver: Spojeni schvaleno bez podminek.", outcome: "approved", turnover: null },
    { case_number: "UOHS-M0003/2024", title: "Fuze v bankovnim sektoru", date: "2024-10-05", sector: "banking", acquiring_party: "Banka Gamma, a.s.", target: "Financni instituce Delta, a.s.", summary: "UOHS zahajil hloubkove posouzeni fuze dvou stredne velkych bank.", full_text: "Zahajeni Faze II UOHS-M0003/2024\n\nDuvody: kombinovany trzni podil pres 25 % v retailovych hypotekach, obavy z koordinacnich ucinku na SME uvery.\n\nOcekavane rozhodnuti do 90 pracovnich dnu.", outcome: "under_review", turnover: null },
];
const iD = db.prepare("INSERT OR REPLACE INTO decisions (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, competition_articles, status) VALUES (@case_number, @title, @date, @type, @sector, @parties, @summary, @full_text, @outcome, @fine_amount, @competition_articles, @status)");
const iM = db.prepare("INSERT OR REPLACE INTO mergers (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover) VALUES (@case_number, @title, @date, @sector, @acquiring_party, @target, @summary, @full_text, @outcome, @turnover)");
for (const d of decisions)
    iD.run(d);
for (const m of mergers)
    iM.run(m);
console.log("Seeded " + decisions.length + " decisions, " + mergers.length + " mergers into " + DB_PATH);
db.close();
