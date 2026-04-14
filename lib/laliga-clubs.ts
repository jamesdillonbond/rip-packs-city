export const LALIGA_CLUB_ABBREVS: Record<string, string> = {
  "Athletic Club": "ATH",
  "Atl\u00E9tico de Madrid": "ATM",
  "CA Osasuna": "OSA",
  "CD Legan\u00E9s": "LEG",
  "Celta de Vigo": "CEL",
  "Deportivo Alav\u00E9s": "ALA",
  "FC Barcelona": "FCB",
  "Getafe CF": "GET",
  "Girona FC": "GIR",
  "RCD Espanyol": "ESP",
  "RCD Espanyol de Barcelona": "ESP",
  "RCD Mallorca": "MLL",
  "Rayo Vallecano": "RAY",
  "Real Betis": "BET",
  "Real Madrid CF": "RMA",
  "Real Sociedad": "RSO",
  "Real Valladolid CF": "VLL",
  "Sevilla FC": "SEV",
  "UD Almer\u00EDa": "ALM",
  "UD Las Palmas": "LPA",
  "Valencia CF": "VCF",
  "Villarreal CF": "VIL",
  "SD Eibar": "EIB",
  "SD Huesca": "HUE",
  "C\u00E1diz CF": "CAD",
  "Elche CF": "ELC",
  "Granada CF": "GRA",
  "Levante UD": "LEV",
}

export function getClubAbbrev(teamName: string): string {
  if (!teamName) return "???"
  return LALIGA_CLUB_ABBREVS[teamName] ?? teamName.slice(0, 3).toUpperCase()
}
