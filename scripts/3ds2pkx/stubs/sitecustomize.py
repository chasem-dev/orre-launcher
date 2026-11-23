# Stand-ins for Blender's modules, so the addon's package imports outside Blender (as its tests/conftest.py does).
import sys, types
from unittest.mock import MagicMock

class _Stub(types.ModuleType):
    """A module whose capitalised names are plain classes (to subclass) and the rest mocks."""
    def __getattr__(self, name):
        if name.startswith('__'):
            raise AttributeError(name)
        value = type(name, (), {}) if name[:1].isupper() and self.__name__ != 'bpy.props' else MagicMock(name=f'{self.__name__}.{name}')
        setattr(self, name, value)
        return value

sys.modules.setdefault('mathutils', MagicMock(name='mathutils'))
for name in ('bpy', 'bpy.types', 'bpy.props', 'bpy.utils', 'bpy.app', 'bpy_extras', 'bpy_extras.io_utils'):
    if name not in sys.modules:
        sys.modules[name] = _Stub(name)
sys.modules['bpy'].types = sys.modules['bpy.types']
sys.modules['bpy'].props = sys.modules['bpy.props']
sys.modules['bpy_extras'].io_utils = sys.modules['bpy_extras.io_utils']
