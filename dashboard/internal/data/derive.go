package data

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// The tracker's Notes column is free-text, but evaluations write it with stable
// conventions: work mode ("Remote US", "Charlotte NC (Hybrid)"), a pay range
// ("$140-210K (POSTED)" / "~$150-220K (est)") and event dates ("Rejected
// 2026-06-04"). These regexes lift that structure back out so the dashboard can
// show Location / Pay / Last-contact columns without a tracker schema change.
var (
	// Pay amounts in user-written Notes. Currencies are listed in currencyTokens
	// below — the regex is assembled from that slice in three positions
	// (prefix, optional range-prefix, suffix) so adding a new currency is a
	// one-line append. The B suffix is matched too (not for pay itself, but so
	// a billion-scale valuation like "$7.6B" is captured as one token and can
	// be excluded by reFundingContext below — otherwise the "B" would be left
	// dangling after the match and the trailing "valuation" check would never
	// see it). payCeiling is currency-naive; PayMax sorts numerically.
	reMoneySpan = buildMoneySpanRegex(currencyTokens)
	// ISO dates embedded in notes ("Rejected 2026-06-04", "viewed 2026-06-04")
	reISODate = regexp.MustCompile(`\b20\d{2}-\d{2}-\d{2}\b`)

	// "posted 2026-08-07" / "Posted: 2026-08-07" — when the requisition went
	// live, as written into the tracker notes. Distinct from the "(POSTED)"
	// pay-source marker, which carries no date.
	//
	// Anchored to the start of a line or a note segment, NOT to a word boundary.
	// The date this matches is subtracted from the last-contact scan below, so
	// an over-broad match does not merely mislabel a date — it deletes a real
	// interaction. With `\bposted`, the note "Recruiter posted 2026-07-20 update
	// on the req" on a row dated 2026-06-01 moved LastContact from 2026-07-20
	// back to 2026-06-01: a recruiter contact that happened, silently gone.
	// Segment-anchored, that same prose is left alone and only a deliberate
	// `posted: <date>` segment is read as posting metadata.
	//
	// Capture 1 is the anchor itself so the stripping below can put it back;
	// capture 2 is the date. The colon form accepts no space after it
	// ("posted:2026-07-15"), the bare form requires one, so "posted2026-07-15"
	// is not a date segment.
	rePostedOn = regexp.MustCompile(`(?im)(^|[;|])[^\S\n]*posted(?::[^\S\n]*|[^\S\n]+)(20\d{2}-\d{2}-\d{2})\b`)
	// "City ST" / "City, ST" with a strict two-letter US state code so prose like
	// "Sams AI" or "Kerin Colby DONE" can't false-positive.
	reCityState = regexp.MustCompile(`\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),? (A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b`)
	// A place in the syntactic position the tracker actually writes it in:
	// immediately before a work-mode word ("Erlangen hybrid", "Nuremberg
	// on-site"). This identifies a location by its position in the sentence
	// rather than by membership in a list, so a city nobody thought to enumerate
	// still resolves — reCityIntl below had no entry for Erlangen, Nuremberg or
	// Fürth, which between them account for most of the home market, and every
	// such row rendered a blank Location. Checked before reCityIntl for that
	// reason. Not (?i): the leading capital is what distinguishes a place name
	// from prose, so the mode words spell out both cases instead.
	rePlaceWithMode = regexp.MustCompile(`\b(\p{Lu}[\p{L}.'-]+(?: \p{Lu}[\p{L}.'-]+){0,2})[ ,(]+(?:[Hh]ybrid|[Oo]n-?site|[Ii]n-office|[Rr]emote)\b`)
	// A conditional cue in the clause immediately preceding a candidate match.
	// "Verify the remote option is still on offer - if it becomes Munich on-site
	// the score drops" describes a hypothetical relocation; reading it as the
	// job's location contradicted the same note's opening words ("Remote within
	// Germany"). Anchored to the end and stopping at sentence punctuation so
	// only the SAME clause is inspected — an "if" two sentences earlier is
	// unrelated to the match.
	reConditional = regexp.MustCompile(`(?i)\b(if|unless|should|were|in case)\b[^.;!?]*$`)
	// International cities, checked only when neither of the above matches, so
	// European/other non-US roles still surface a Location. Cities only (not bare
	// country names) to avoid prose false-positives like "Portugal eligible" or
	// "remote in Germany", which describe eligibility, not the job's location.
	// This list is a fallback for notes that name a city with no work-mode word
	// attached; rePlaceWithMode is what keeps an unlisted city from vanishing.
	reCityIntl = regexp.MustCompile(`(?i)\b(Porto|Lisbon|London|Berlin|Munich|M(?:ü|u)nchen|Hamburg|Frankfurt|Cologne|K(?:ö|o)ln|D(?:ü|u)sseldorf|Stuttgart|Erlangen|N(?:ü|u)rnberg|Nuremberg|F(?:ü|u)rth|Bamberg|Bayreuth|W(?:ü|u)rzburg|Regensburg|Ingolstadt|Augsburg|Darmstadt|Karlsruhe|Mannheim|Heidelberg|Freiburg|Ulm|T(?:ü|u)bingen|Kassel|G(?:ö|o)ttingen|Hannover|Braunschweig|Bremen|Kiel|L(?:ü|u)beck|Rostock|Magdeburg|Leipzig|Dresden|Chemnitz|Jena|Erfurt|Potsdam|Bonn|Aachen|Essen|Dortmund|Bochum|Duisburg|M(?:ü|u)nster|Paderborn|Bielefeld|Wuppertal|Mainz|Wiesbaden|Saarbr(?:ü|u)cken|Koblenz|Trier|Kaiserslautern|Konstanz|Passau|Linz|Graz|Innsbruck|Salzburg|Z(?:ü|u)rich|Geneva|Lausanne|Basel|Bern|Dublin|Cork|Amsterdam|Rotterdam|Eindhoven|Utrecht|Paris|Lyon|Madrid|Barcelona|Valencia|Stockholm|Gothenburg|Malm(?:ö|o)|Copenhagen|Oslo|Helsinki|Milan|Rome|Turin|Vienna|Brussels|Ghent|Antwerp|Luxembourg|Warsaw|Krak(?:ó|o)w|Wroc(?:ł|l)aw|Tallinn|Riga|Vilnius|Prague|Brno|Budapest|Bucharest|Sofia|Athens|Bengaluru|Bangalore|Singapore|Sydney|Toronto|Vancouver|Tel Aviv|S(?:ã|a)o Paulo)\b`)
	// Individual amounts inside an already-matched span: "140", "210K", "209,983"
	reMoneyPart = regexp.MustCompile(`(\d[\d,]*(?:\.\d+)?)\s*([KkMmBb]?)`)
	// Estimate markers: "(est)", "(est;", "market est)" or "market" as its own
	// word — but not "(EST/CST" timezones, "interest)" or "marketing".
	reEstHint = regexp.MustCompile(`\(est[),;. ]|\best\)|\bmarket\b`)
	// Funding/valuation context immediately after a money match: "$600M
	// valuation", "$124M total raised", "$70M Series C" describe the company,
	// not pay, and must not be picked up as the Pay column's figure.
	reFundingContext = regexp.MustCompile(`(?i)^\s*(valuation|(total\s+)?raised|series\s|round\b)`)
)

// currencyTokens is the single source of truth for currencies the dashboard
// recognizes in Notes. Suffix tokens emit without trailing space — the
// leading \s+ prevents the trailing-space-eat bug ("150-200K PLN ").
var currencyTokens = []string{
	"$", "€", "£", "¥", "₹", "₺", "₩", "zł", "₴",
	"CHF", "EUR", "USD", "GBP", "PLN", "UAH",
	"JPY", "CNY", "INR", "BRL", "SEK", "NOK", "DKK", "TRY", "KRW",
	"AUD", "CAD", "MXN", "SGD", "HKD", "ZAR",
}

// buildMoneySpanRegex assembles the regex from an explicit currency list,
// emitting each token in three positions (prefix, optional range-prefix,
// suffix). Adding a new currency is a one-line append to currencyTokens;
// An empty list produces a regex that matches nothing.
func buildMoneySpanRegex(currencies []string) *regexp.Regexp {
	if len(currencies) == 0 {
		return regexp.MustCompile(`\b\B`)
	}
	prefixParts, rangePrefixParts, suffixParts := make([]string, 0, len(currencies)), make([]string, 0, len(currencies)), make([]string, 0, len(currencies))
	for _, tok := range currencies {
		// QuoteMeta: "$" is end-of-string anchor, "." is wildcard, etc.
		q := regexp.QuoteMeta(tok)
		if isBareSymbol(tok) {
			prefixParts = append(prefixParts, q)
			rangePrefixParts = append(rangePrefixParts, q)
			suffixParts = append(suffixParts, q)
		} else {
			prefixParts = append(prefixParts, q+" ?")
			rangePrefixParts = append(rangePrefixParts, q+" ?")
			suffixParts = append(suffixParts, q)
		}
	}
	pattern := fmt.Sprintf(
		`~?(?:(?:%s)\s*\d[\d,]*(?:\.\d+)?[KkMmBb]?`+
			`(?:\s*[-–]\s*(?:%s)?\d[\d,]*(?:\.\d+)?[KkMmBb]?)?`+
			`|\d[\d,]*(?:\.\d+)?[KkMmBb]?`+
			`(?:\s*[-–]\s*\d[\d,]*(?:\.\d+)?[KkMmBb]?)?`+
			`\s+(?:%s))`,
		strings.Join(prefixParts, "|"),
		strings.Join(rangePrefixParts, "|"),
		strings.Join(suffixParts, "|"),
	)
	return regexp.MustCompile(pattern)
}

// isBareSymbol reports whether a currency token is a symbol ("$", "€", "£",
// "zł", "₴") rather than an ISO code ("PLN", "UAH", "CHF"). Rule: no
// uppercase ASCII letter ⇒ bare.
func isBareSymbol(tok string) bool {
	for _, r := range tok {
		if r >= 'A' && r <= 'Z' {
			return false
		}
	}
	return true
}

// payCeiling converts a matched pay span to its top dollar amount for sorting:
// "$140-210K" → 210000, "$174,986-209,983" → 209983, "$170K" → 170000.
func payCeiling(span string) float64 {
	top := 0.0
	for _, p := range reMoneyPart.FindAllStringSubmatch(span, -1) {
		v, err := strconv.ParseFloat(strings.ReplaceAll(p[1], ",", ""), 64)
		if err != nil {
			continue
		}
		switch strings.ToLower(p[2]) {
		case "k":
			v *= 1_000
		case "m":
			v *= 1_000_000
		case "b":
			v *= 1_000_000_000
		}
		if v > top {
			top = v
		}
	}
	return top
}

// notAPlace holds capitalised words that never name anywhere, but that do turn
// up in the syntactic position a place would occupy. Two groups:
//
//   - Degree adverbs in front of a work-mode word ("Fully Remote", "Mostly
//     Hybrid"), which rePlaceWithMode would otherwise report as the location.
//   - Identifier labels in front of a two-letter token, which reCityState reads
//     as a US state code: "Job ID 516133" parses as the city "Job" in Idaho.
//     AGENTS.md tells the user to put exactly that in the notes column to
//     disambiguate two same-title requisitions, so it is the common case, not a
//     corner one — "Req OR", "Posting IN", "Ref DE" fail the same way.
//
// Only the word directly adjacent to the marker is checked, since that is the
// one the pattern would report.
var notAPlace = map[string]bool{
	"Fully": true, "Mostly": true, "Partially": true, "Full": true,
	"Part": true, "Semi": true, "Flexible": true, "Mainly": true,
	"Primarily": true, "Largely": true, "Now": true, "All": true,
	"Some": true, "And": true, "Or": true, "The": true, "Is": true,
	"Was": true, "Also": true, "Plus": true, "With": true, "Not": true,
	"Job": true, "Jobs": true, "Req": true, "Requisition": true,
	"Posting": true, "Post": true, "Ref": true, "Reference": true,
	"Order": true, "Case": true, "Ticket": true, "Vacancy": true,
	"Position": true, "Role": true, "Application": true, "Employee": true,
}

// isPlaceLike rejects a capture whose word adjacent to the marker is a known
// non-place. Used as the accept filter for the reCityState and rePlaceWithMode
// tiers, both of which capture the candidate place in group 1.
func isPlaceLike(groups []string) bool {
	fields := strings.Fields(groups[1])
	return len(fields) > 0 && !notAPlace[fields[len(fields)-1]]
}

// findUnconditional returns the submatches of the first match of re in s that is
// NOT sitting inside a conditional clause and that accept approves, or nil if
// there is no such match. Group 0 is the whole match, mirroring
// FindStringSubmatch. A nil accept takes every match.
//
// The conditional skip exists because a tracker note records both what the job
// is and what would change the assessment, in the same sentence stream. A
// pattern that takes the first match anywhere cannot tell the two apart.
func findUnconditional(re *regexp.Regexp, s string, accept func([]string) bool) []string {
	for _, idx := range re.FindAllStringSubmatchIndex(s, -1) {
		if reConditional.MatchString(s[:idx[0]]) {
			continue
		}
		groups := make([]string, len(idx)/2)
		for g := range groups {
			if idx[2*g] >= 0 {
				groups[g] = strings.TrimSpace(s[idx[2*g]:idx[2*g+1]])
			}
		}
		if accept != nil && !accept(groups) {
			continue
		}
		return groups
	}
	return nil
}

// deriveLocation resolves the Location column from the tracker's free text.
//
// Tiers run most-specific first, and each tier checks Notes before Role — some
// rows carry the city only in the role title ("... — Charlotte, NC"):
//
//  1. US "City, ST" — a near-unambiguous shape, so it wins outright, once
//     notAPlace has ruled out the label phrases that mimic it ("Job ID").
//  2. A place immediately before a work-mode word ("Erlangen hybrid"). Position
//     in the sentence, not a list, so an unlisted city still resolves.
//  3. The curated international city list, for notes that name a city with no
//     work-mode word attached.
func deriveLocation(app *model.CareerApplication) string {
	for _, text := range []string{app.Notes, app.Role} {
		if m := findUnconditional(reCityState, text, isPlaceLike); m != nil {
			return m[1] + ", " + m[2]
		}
	}
	for _, text := range []string{app.Notes, app.Role} {
		if m := findUnconditional(rePlaceWithMode, text, isPlaceLike); m != nil {
			return m[1]
		}
	}
	for _, text := range []string{app.Notes, app.Role} {
		if m := findUnconditional(reCityIntl, text, nil); m != nil {
			return m[0]
		}
	}
	return ""
}

// deriveNoteFields populates Location, WorkMode, PayRange, PaySource and
// LastContact from the application's Notes (plus Role for work-mode keywords).
func deriveNoteFields(app *model.CareerApplication) {
	lower := strings.ToLower(app.Role + " " + app.Notes)

	app.Location = deriveLocation(app)

	// Work mode: hybrid beats remote ("Remote/hybrid" means office days exist);
	// "remote-first" / "remote + flex" is softer than fully remote;
	// a bare city+state with no keyword implies fully on-site.
	switch {
	case strings.Contains(lower, "hybrid"):
		app.WorkMode = "Hybrid"
	case strings.Contains(lower, "remote") &&
		(strings.Contains(lower, "flex") ||
			strings.Contains(lower, "remote-first") ||
			strings.Contains(lower, "remote first")):
		app.WorkMode = "RemoteFlex"
	case strings.Contains(lower, "remote"):
		app.WorkMode = "Remote"
	case strings.Contains(lower, "onsite") || strings.Contains(lower, "on-site") || strings.Contains(lower, "in-office"):
		app.WorkMode = "Full"
	case app.Location != "":
		app.WorkMode = "Full"
	}

	// Pay: prefer the first $-range; fall back to the first lone $-amount
	// (e.g. "$170K min floor") only when no range exists. Skip money spans
	// that are actually funding/valuation figures ("$600M valuation", "$70M
	// Series C") — they describe the company, not compensation.
	var matches []string
	for _, idx := range reMoneySpan.FindAllStringIndex(app.Notes, -1) {
		if reFundingContext.MatchString(app.Notes[idx[1]:]) {
			continue
		}
		matches = append(matches, app.Notes[idx[0]:idx[1]])
	}
	for _, mm := range matches {
		if strings.ContainsAny(mm, "-–") {
			app.PayRange = mm
			break
		}
	}
	if app.PayRange == "" && len(matches) > 0 {
		app.PayRange = matches[0]
	}
	app.PayMax = payCeiling(app.PayRange)
	if app.PayRange != "" {
		switch {
		case strings.Contains(lower, "(posted"):
			app.PaySource = "POSTED"
		case reEstHint.MatchString(lower):
			app.PaySource = "est"
		}
	}

	// Posting date: when the requisition went live. Drives the POSTED column,
	// which answers "is this req still plausibly being worked?" — a role posted
	// yesterday is a very different bet from one that has sat open for months.
	// Two posting segments in one note is a re-post, not a contradiction: the
	// column answers "how long has this been open", so the latest one is the
	// live requisition and the earlier one is history. Taking the first match
	// would pin the row to a req that has already been replaced.
	for _, m := range rePostedOn.FindAllStringSubmatch(app.Notes, -1) {
		if m[2] > app.PostedOn {
			app.PostedOn = m[2]
		}
	}

	// Last contact: the most recent ISO date mentioned anywhere in the notes
	// (rejections, recruiter views, phone screens), else the applied date.
	// The posting date is stripped first — when the req went live is not an
	// interaction with the company, and letting it through would show a
	// freshly-posted role as if it had just been touched.
	// "$1" keeps the anchor (the line start or the `;`/`|` separator) so removing
	// a segment cannot weld its neighbours into one.
	contactNotes := rePostedOn.ReplaceAllString(app.Notes, "$1")
	last := app.Date
	for _, d := range reISODate.FindAllString(contactNotes, -1) {
		if d > last {
			last = d
		}
	}
	app.LastContact = last
}
