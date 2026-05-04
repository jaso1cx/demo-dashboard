import os

from repos.composite import CompositeRepo
from repos.supabase import SupabaseRpcRepo


def create_repo():
    repos = []

    enable_supabase = (os.getenv("ENABLE_SUPABASE", "1") or "1").strip().lower() not in ("0", "false", "no")
    if enable_supabase:
        repos.append(SupabaseRpcRepo())

    enable_firebase = (os.getenv("ENABLE_FIREBASE", "1") or "1").strip().lower() not in ("0", "false", "no")
    if enable_firebase:
        from repos.netgauge import NetGaugeRepo
        repos.append(NetGaugeRepo())

    '''    Additional repos can be added here by checking environment variables and appending to the repos list.
    '''

    if not repos:
        raise RuntimeError("No measurement sources enabled (set ENABLE_SUPABASE=1 or add another repo source).")

    return CompositeRepo(repos)
