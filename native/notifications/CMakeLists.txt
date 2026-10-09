add_executable(attaclip-notifier WIN32 windows.cpp)
target_include_directories(attaclip-notifier PRIVATE ../vendor)
target_compile_definitions(attaclip-notifier PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
target_link_libraries(attaclip-notifier PRIVATE gdiplus user32 gdi32 psapi)
