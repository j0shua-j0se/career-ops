package data

import (
	"html"
	"net/url"
	"strings"
)

// blockedAggregatorHosts lists job-aggregator hosts that are known to refuse
// the user's own browser (e.g. www.stepstone.de answering "403 Zugriff
// verweigert" to a direct visit), making their tracker URLs a dead click.
// Add a bare registrable domain here; IsBlockedAggregatorURL matches it and
// any subdomain, case-insensitively.
var blockedAggregatorHosts = []string{
	"stepstone.de",
}

// IsBlockedAggregatorURL reports whether u's host is one of
// blockedAggregatorHosts or a subdomain of one. Parsing tolerates a missing
// scheme (e.g. "www.stepstone.de/job/123"), and the comparison is
// case-insensitive. Empty or unparsable input reports false.
func IsBlockedAggregatorURL(u string) bool {
	host := strings.ToLower(hostOf(strings.TrimSpace(u)))
	if host == "" {
		return false
	}
	for _, blocked := range blockedAggregatorHosts {
		if host == blocked || strings.HasSuffix(host, "."+blocked) {
			return true
		}
	}
	return false
}

// hostOf extracts the hostname from u, retrying with an "https://" prefix
// when the first parse finds no host — the shape url.Parse produces for a
// scheme-less input like "www.stepstone.de/job/123" (the whole string lands
// in Path, Host is empty).
func hostOf(u string) string {
	if u == "" {
		return ""
	}
	if parsed, err := url.Parse(u); err == nil && parsed.Host != "" {
		return parsed.Hostname()
	}
	if parsed, err := url.Parse("https://" + u); err == nil {
		return parsed.Hostname()
	}
	return ""
}

// EmployerSearchURL returns a Google search URL for the given employer and
// role, used as a fallback destination when the tracker's own JobURL is
// blocked (see IsBlockedAggregatorURL). HTML entities occasionally present in
// tracker text (e.g. "&amp;") are unescaped first, and surrounding/collapsed
// whitespace is trimmed before the query is escaped.
func EmployerSearchURL(company, role string) string {
	company = html.UnescapeString(company)
	role = html.UnescapeString(role)
	query := strings.Join(strings.Fields(company+" "+role+" karriere"), " ")
	return "https://www.google.com/search?q=" + url.QueryEscape(query)
}
