import { useParams } from "react-router-dom";

/**
 * Builds an absolute path under the current organization
 * (/org/:orgSlug/...) from a route-relative path like "/schedule".
 *
 * Needed because react-router's <Link to="/x"> and navigate("/x") are
 * always root-absolute, never relative to how deeply the current route is
 * nested (unlike <Route path="/x">, which matches relative to its mount
 * point) - see App.tsx's /org/:orgSlug/* mount. Every in-app nav link and
 * programmatic navigation that used to be a bare "/x" now needs this
 * prefix, or it would bounce to a path outside the current organization
 * entirely.
 */
export function useOrgPath() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return function orgPath(path: string) {
    // path === "/" (the org's own home/Command Center) must NOT produce a
    // trailing slash - "/org/acme/" vs "/org/acme" are different strings
    // to NavLink's exact ("end") active-match, and a real browser location
    // is never the former, so a naive concatenation would leave the home
    // nav item permanently unable to show as active.
    if (path === "/") return `/org/${orgSlug}`;
    return `/org/${orgSlug}${path}`;
  };
}
