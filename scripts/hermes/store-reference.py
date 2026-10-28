"""Exercise the actual pinned upstream MemoryStore with only filesystem/registry shims.
No model, API credentials, or installation of the full Hermes agent is needed.
"""
import sys, types, pathlib, importlib.util, json, tempfile, os, fcntl
root = pathlib.Path(sys.argv[1]).resolve()
request = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as tmp:
    home = pathlib.Path(tmp)
    package = types.ModuleType('tools'); package.__path__ = [str(root / 'tools')]; sys.modules['tools'] = package
    utils = types.ModuleType('utils')
    def atomic_write_text(path, text, **kwargs):
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.tmp'); temp.write_text(text, encoding='utf-8'); os.replace(temp, path)
    utils.atomic_write_text = atomic_write_text; sys.modules['utils'] = utils
    constants = types.ModuleType('hermes_constants')
    constants.mkdir_under_hermes_home = lambda path: path.mkdir(parents=True, exist_ok=True)
    sys.modules['hermes_constants'] = constants
    tool = types.ModuleType('tools.memory_tool'); tool.get_memory_dir = lambda: home
    tool.fcntl = fcntl; tool.msvcrt = None
    tool._memory_target_error = lambda store, target, operations=None: None
    sys.modules['tools.memory_tool'] = tool; package.memory_tool = tool
    from tools.memory_tool_store import MemoryStore
    store = MemoryStore(memory_char_limit=request.get('limit', 2200))
    if request.get('initial') is not None:
        (home / 'MEMORY.md').write_text(request['initial'], encoding='utf-8')
    results = []
    for operations in request['batches']:
        result = store.apply_batch('memory', operations)
        filename = home / 'MEMORY.md'
        results.append({'success': result['success'], 'done': result.get('done', False), 'text': filename.read_text(encoding='utf-8') if filename.exists() else ''})
    print(json.dumps(results, ensure_ascii=False))
