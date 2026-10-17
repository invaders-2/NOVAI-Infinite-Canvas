import atexit
import os
import shutil
import tempfile

# 这些单测会 import main；main 在未设置 NOVAI_DATA_DIR 时把画布版本 / 线程等数据写进项目目录（data/），
# 跑一次就会污染正式数据。这里默认指向临时目录；调用方已显式设置 NOVAI_DATA_DIR 时不覆盖其选择。
# main 还会从数据目录读 API/.env（API Key 等），按旧行为把这份配置带到临时目录，避免隔离后测试失去密钥。
if "NOVAI_DATA_DIR" not in os.environ:
    _root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _tmp = tempfile.mkdtemp(prefix="novai-tests-")
    _env_src = os.path.join(_root, "API", ".env")
    if os.path.isfile(_env_src):
        os.makedirs(os.path.join(_tmp, "API"), exist_ok=True)
        shutil.copy2(_env_src, os.path.join(_tmp, "API", ".env"))
    atexit.register(shutil.rmtree, _tmp, ignore_errors=True)
    os.environ["NOVAI_DATA_DIR"] = _tmp
