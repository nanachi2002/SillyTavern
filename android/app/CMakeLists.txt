cmake_minimum_required(VERSION 3.22.1)
project(sillytavern-node CXX)

add_library(sillytavern-node SHARED src/main/cpp/native-lib.cpp)

# Node.js headers matching nodejs-mobile's libnode.so (v18)
target_include_directories(sillytavern-node PRIVATE ${CMAKE_SOURCE_DIR}/libnode/include/node)

# libnode.so from nodejs-mobile, fetched by mobile/fetch-libnode.mjs (16 KB page aligned)
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(sillytavern-node libnode ${log-lib})
# Android 15+ devices may use 16 KB memory pages
target_link_options(sillytavern-node PRIVATE "-Wl,-z,max-page-size=16384")
