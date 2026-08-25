# app/services/bgtasks.py
# Zajednicki helper za "fire-and-forget" background taskove (notifikacije,
# audit log, automatizacija) -- bez cuvanja reference, Python-ov Garbage
# Collector moze da obrise asyncio.Task USRED izvrsavanja (event loop drzi
# samo slabu referencu), ostavljajuci npr. izvrsavanje skripte zauvek u
# statusu "running" bez ikakvog loga ili greske. Koristiti create_bg_task()
# UMESTO golog asyncio.create_task() za bilo koji fire-and-forget posao.
import asyncio

_background_tasks: set = set()


def create_bg_task(coro):
    t = asyncio.create_task(coro)
    _background_tasks.add(t)
    t.add_done_callback(_background_tasks.discard)
    return t
