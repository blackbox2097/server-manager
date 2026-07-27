# app/services/audit_query.py -- deljena logika za filtriranje audit_log upita.
# Koriste je i /api/admin/audit (superadmin, svi tenanti) i /api/tenants/{tid}/logs
# (tenant-scoped) -- ranije je identicna logika bila duplirana na oba mesta.


def build_audit_filter(
    prefix: str = "",
    tenant_id: str | None = None,
    action: str | None = None,
    user_id: str | None = None,
    success: bool | None = None,
    search: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> tuple[list[str], list]:
    """Vraca (cond, params).

    cond je lista SQL uslova (bez WHERE/AND spajanja) -- pozivalac ih spaja sa
    ' AND '.join(cond). params je lista bind vrednosti u odgovarajucem redosledu,
    a placeholderi (${n}) su vec ugradjeni u cond na osnovu duzine params u tom
    trenutku, tako da pozivalac moze bezbedno da doda jos parametara (npr. limit,
    offset) posle poziva ove funkcije.

    prefix: opciona alijas prefiksa kolone (npr. "a" za "a.action", kad upit
    ima JOIN i kolone moraju biti kvalifikovane).
    """
    p = f"{prefix}." if prefix else ""
    cond: list[str] = []
    params: list = []

    if tenant_id:
        params.append(tenant_id)
        cond.append(f"{p}tenant_id=${len(params)}")
    if action:
        params.append(f"{action}%")
        cond.append(f"{p}action LIKE ${len(params)}")
    if user_id:
        params.append(user_id)
        cond.append(f"{p}user_id=${len(params)}")
    if success is not None:
        params.append(success)
        cond.append(f"{p}success=${len(params)}")
    if search:
        params.append(f"%{search}%")
        n = len(params)
        cond.append(
            f"({p}username ILIKE ${n} OR {p}resource_id ILIKE ${n} "
            f"OR {p}details::text ILIKE ${n} OR {p}action ILIKE ${n})"
        )
    if date_from:
        params.append(date_from)
        cond.append(f"{p}occurred_at >= ${len(params)}")
    if date_to:
        params.append(date_to)
        cond.append(f"{p}occurred_at <= ${len(params)}")

    return cond, params
