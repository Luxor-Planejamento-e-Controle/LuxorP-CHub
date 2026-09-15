"""Dia útil do mercado brasileiro — guarda para rotina agendada.

Cron (Azure, NCRONTAB, Task Scheduler) não sabe o que é feriado, e não adianta
tentar resolver no próprio cron: com dia-do-mês e dia-da-semana preenchidos
juntos o cron faz OR, não AND, e a rotina passaria a rodar MAIS dias, não
menos. Por isso a guarda mora aqui, no código.

Dia útil aqui = seg-sex, fora dos feriados nacionais (lib `holidays`) e fora
dos dias em que a B3 não abre e que a lib não traz: Carnaval (segunda e terça)
e Corpus Christi. É o calendário que importa — as rotinas dependem de fonte que
só é publicada em dia de pregão.

Como script, serve de guarda em linha de comando (`python dia_util.py`):
sai 0 se hoje é dia útil, 1 se não é.
"""
import datetime as dt
import sys

import holidays


def _pascoa(ano):
    """Domingo de Páscoa (algoritmo de Meeus/Butcher)."""
    a = ano % 19
    b, c = divmod(ano, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    ell = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ell) // 451
    mes, dia = divmod(h + ell - 7 * m + 114, 31)
    return dt.date(ano, mes, dia + 1)


def _sem_pregao(ano):
    """Datas do ano em que não há pregão (feriado nacional + móveis da B3)."""
    datas = set(holidays.Brazil(years=ano).keys())
    pascoa = _pascoa(ano)
    datas.add(pascoa - dt.timedelta(days=48))   # Carnaval — segunda
    datas.add(pascoa - dt.timedelta(days=47))   # Carnaval — terça
    datas.add(pascoa + dt.timedelta(days=60))   # Corpus Christi
    return datas


def eh_dia_util(d=None):
    """True se `d` (default: hoje) é dia útil de mercado."""
    d = d or dt.date.today()
    return d.weekday() < 5 and d not in _sem_pregao(d.year)


def proximo_dia_util(d=None):
    """Primeiro dia útil em `d` ou depois."""
    d = d or dt.date.today()
    while not eh_dia_util(d):
        d += dt.timedelta(days=1)
    return d


def dia_util_anterior(d=None):
    """Último dia útil ANTES de `d` (default: hoje)."""
    d = (d or dt.date.today()) - dt.timedelta(days=1)
    while not eh_dia_util(d):
        d -= dt.timedelta(days=1)
    return d


def primeiro_dia_util_do_mes(ano=None, mes=None):
    """Primeiro dia útil do mês (default: o mês corrente)."""
    hoje = dt.date.today()
    return proximo_dia_util(dt.date(ano or hoje.year, mes or hoje.month, 1))


def eh_primeiro_dia_util_do_mes(d=None):
    d = d or dt.date.today()
    return d == primeiro_dia_util_do_mes(d.year, d.month)


if __name__ == "__main__":
    hoje = dt.date.today()
    if eh_dia_util(hoje):
        print(f">>> {hoje:%d/%m/%Y} é dia útil — segue.")
        sys.exit(0)
    print(f">>> {hoje:%d/%m/%Y} não é dia útil (fim de semana ou feriado) — pula.")
    sys.exit(1)
