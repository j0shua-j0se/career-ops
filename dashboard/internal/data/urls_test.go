package data

import (
	"net/url"
	"strings"
	"testing"
)

func TestIsBlockedAggregatorURL(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want bool
	}{
		{"bare domain", "stepstone.de", true},
		{"bare domain with scheme", "https://stepstone.de/some/path", true},
		{"www subdomain", "https://www.stepstone.de/stellenangebote--1234.html", true},
		{"www subdomain no scheme", "www.stepstone.de/stellenangebote--1234.html", true},
		{"uppercase host", "https://STEPSTONE.DE/jobs/1", true},
		{"mixed-case subdomain", "https://Www.StepStone.De/jobs/1", true},
		{"lookalike suffix domain is not a subdomain", "https://stepstone.de.evil.com/phish", false},
		{"unrelated host with stepstone-like path", "https://karriere.adac.de/stepstone.de/jobs", false},
		{"unrelated host", "https://karriere.adac.de/jobs/1", false},
		{"empty", "", false},
		{"whitespace only", "   ", false},
		{"greenhouse is unaffected", "https://boards.greenhouse.io/acme/jobs/123", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsBlockedAggregatorURL(tc.url)
			if got != tc.want {
				t.Fatalf("IsBlockedAggregatorURL(%q) = %v, want %v", tc.url, got, tc.want)
			}
		})
	}
}

func TestEmployerSearchURL(t *testing.T) {
	got := EmployerSearchURL("Acme & Co", "Backend Engineer")

	const prefix = "https://www.google.com/search?q="
	if !strings.HasPrefix(got, prefix) {
		t.Fatalf("EmployerSearchURL result = %q, want prefix %q", got, prefix)
	}

	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatalf("EmployerSearchURL produced an unparsable URL: %v", err)
	}
	q := parsed.Query().Get("q")
	if q != "Acme & Co Backend Engineer karriere" {
		t.Fatalf("decoded query = %q, want %q", q, "Acme & Co Backend Engineer karriere")
	}
}

func TestEmployerSearchURLUnescapesHTMLEntitiesAndTrimsSpaces(t *testing.T) {
	got := EmployerSearchURL("  Acme &amp; Co  ", "  Backend Engineer  ")

	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatalf("EmployerSearchURL produced an unparsable URL: %v", err)
	}
	q := parsed.Query().Get("q")
	if q != "Acme & Co Backend Engineer karriere" {
		t.Fatalf("decoded query = %q, want %q", q, "Acme & Co Backend Engineer karriere")
	}
}

func TestEmployerSearchURLEscapesSpecialCharacters(t *testing.T) {
	got := EmployerSearchURL("Bosch", "Software Engineer (m/w/d)")

	if strings.Contains(got, " ") {
		t.Fatalf("EmployerSearchURL result contains a raw space: %q", got)
	}
	if !strings.Contains(got, "q=") {
		t.Fatalf("EmployerSearchURL result missing query param: %q", got)
	}
}
