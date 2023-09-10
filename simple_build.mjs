'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';

let config_default_values = {
  source_dir : 'src', 
  libs: [
    '-lstdc++'
  ],
  releases : [
    {
      name: 'Debug',
      compile_options : ['g'], 
      link_options : []
    },
    {
      name: 'Release', 
      compile_options: [], 
      link_options: []
    }
  ]
};

function expand_dir( first_path, second_path ){
  if( !first_path )
    return second_path; 
  return `${first_path}${path.sep}${second_path}`;
}

function get_current_release( config, release_name ){
  let release = config.releases.find( release => release.name === release_name );
  if( !release ) {
    release = config.releases[0];
  }
  return release;
}

function read_config( args ) {
  let file_path = 'build_config.json';
  if(args[0]) 
    file_path = args[0];
  let config = JSON.parse( fs.readFileSync( file_path, 
                                  { encoding: 'utf-8' } ) );
  let resulting_config = Object.assign( config_default_values, config );
  resulting_config.source_dir = expand_dir( resulting_config.project_dir, resulting_config.source_dir );

  resulting_config.current_release = get_current_release( resulting_config, args[1] );
  // wipe the releases info, not needed from now
  delete resulting_config.releases;
  resulting_config.current_release.path = expand_dir( resulting_config.project_dir, resulting_config.current_release.name );
  resulting_config.current_release.executable = expand_dir( resulting_config.project_dir, resulting_config.current_release.executable );
  return resulting_config;
}

function create_dir_if_not_exists( dir_name ){
  if(!fs.existsSync( dir_name ) )
    fs.mkdirSync( dir_name );
}

function file_is_newer( path1, path2 ){
  let stat1 = { mtime: new Date('1970-01-01T00:00:00') };
  if( fs.existsSync( path1 ) )
    stat1 = fs.statSync( path1 );
  let stat2 = { mtime: new Date('1970-01-01T00:00:00') };
  if( fs.existsSync( path2 ) )
    stat2 = fs.statSync( path2 ); 
  return stat1.mtime.getTime() > stat2.mtime.getTime();
}

function resolve_option_list( config, option_list ){
  let result = []
  for( let option of option_list ) {
    option = option.replace( '$project_dir', config.project_dir );
    option = option.replace( '$source_dir', config.source_dir );
    result.push( option );
  }
  return result;
}

function compose_compile_command( config, source_path, obj_path ){
  let command = [];
  for( let elem of config.compile_command ){
    if( elem === '$source_path' ){
      command.push( source_path );
      continue;
    }
    if( elem === '$compile_options' ){
      command.push( ...resolve_option_list(config, config.current_release.compile_options) );
      continue;
    }
    if( elem === '$object_path' ){
      command.push( obj_path );
      continue;
    }
    command.push( elem );
  }
  return command;
}

function compose_link_command( config, object_files ){
  let command = [];
  for( let elem of config.link_command ){
    if( elem === '$object_files' ){
      command.push( ...object_files );
      continue;
    }
    if( elem === '$libs' ){
      command.push( ...config.libs );
      continue;
    }
    if( elem === '$link_options' ){
      command.push( ...config.current_release.link_options );
      continue;
    }
    if( elem === '$executable' ){
      command.push( config.current_release.executable );
      continue;
    }
    command.push( elem );
  }
  return command;
}


function run_command( command, options ){
  return new Promise( (resolve, reject) => {
    console.log( command.reduce( (accum, current) => accum + ' ' + current, '' ) );
    let cmd = child_process.spawn( command[0], 
                                  command.splice( 1 ),
                                  options );
    cmd.stdout.on( 'data', output => console.log( output.toString() ) ); 
    cmd.stderr.on( 'data', output => console.error( output.toString() ) );
    cmd.on( 'exit', (code) => {
      if( code === 0 )
        resolve(code);
      else
        reject(code);
      } );
    cmd.on( 'error', (error) => reject( error ) );
  });
}

function get_list_of_header_files( source_full_path ){
  let source = fs.readFileSync( source_full_path, { encoding: 'utf-8' } );
  let header_files = [];
  source.split(/\r?\n/).forEach( line => {
    let match = line.match( /^\s*#\s*include\s+[<\"]([^>\"]*)[>\"]/);
    if( match )
      header_files.push( match[1] );
  } );
  return header_files;
}

function get_list_of_local_header_files( source_dir, source_full_path ){
  let headers = get_list_of_header_files( source_full_path );
  let result = []
  for( let header_file of headers ){
    if( fs.existsSync( `${source_dir}${path.sep}${header_file}` ) ){
      result.push( `${source_dir}${path.sep}${header_file}` );
    }
  }
  return result;
}

function compute_is_dirty( compilation_unit ){
  let is_dirty = false; 
  is_dirty ||= file_is_newer( compilation_unit.source, compilation_unit.obj );
  for( let header of compilation_unit.headers ){
    is_dirty ||= file_is_newer( header, compilation_unit.obj );
  }
  return is_dirty;
}

function get_compilation_units( config ){
  let compilation_units = {};
  // for all source files under config.source_dir....
  for( let source_filename of fs.readdirSync( config.source_dir ) ){
    let source_full_path = `${config.source_dir}${path.sep}${source_filename}`; 
    let source_path_elem = path.parse( source_filename );
    if( !compilation_units[source_path_elem.name] )
      compilation_units[source_path_elem.name] = { obj : '', 
                                                    source: '',
                                                    headers: [],
                                                    is_dirty: false };
    compilation_units[source_path_elem.name]['obj'] = `${config.current_release.path}${path.sep}${source_path_elem.name}.o`;
    if( ['.h', '.hpp' ].includes(source_path_elem.ext) ){
      compilation_units[source_path_elem.name]['headers'].push( source_full_path );
      compilation_units[source_path_elem.name]['headers'].push( ...get_list_of_local_header_files( config.source_dir, source_full_path ) );
    }
    if( ['.c', '.cpp' ].includes(source_path_elem.ext) ){
      compilation_units[source_path_elem.name]['source'] = source_full_path;
      compilation_units[source_path_elem.name]['headers'].push( ...get_list_of_local_header_files( config.source_dir, source_full_path ) );
    }
    compilation_units[source_path_elem.name]['is_dirty'] ||= compute_is_dirty( compilation_units[source_path_elem.name] );
  }
  return compilation_units;
}

function run_compilations( compilation_units ){
  let compile_promises = [];
  for( let [key, compilation_unit] of Object.entries(compilation_units) ){
    if( compilation_unit.is_dirty ){
        compile_promises.push( 
          run_command( compose_compile_command( config, 
                                                compilation_unit.source, 
                                                compilation_unit.obj ) )
        );
    }
    else
        console.log( `No action needed for ${key}` );
  }
  return compile_promises;
}

function main( config ) {

  create_dir_if_not_exists( config.current_release.path );
  let compilation_units = get_compilation_units(config);
 
  Promise.all( run_compilations(compilation_units) )
    .then(
      resolve_data => {
        // for all objects in config.current_release.path... 
        let object_files = fs.readdirSync( config.current_release.path );
        object_files = object_files.map( elem => `${config.current_release.path}${path.sep}${elem}` );
        let any_of_files_newer = false;
        for( let object_file of object_files ){
          any_of_files_newer ||= file_is_newer( object_file, config.current_release.executable );
        }
        if( any_of_files_newer )
          run_command( compose_link_command( config, object_files ) );
        else
          console.log( `No action needed for linking` );
      }
    )
    .catch(
      error => console.error( `No linking was done because of previous errors(${error})` )
    );

}



/**
 * main program
 */
let config = read_config( process.argv.slice(2) );
main( config );
//run_command( ["gcc", "c:\\wkcpp2\\mingw64_template\\src\\main.cpp", "-Werror", "-Wextra", "-Wall", "-pedantic", "-c", "-o", "c:\\wkcpp2\\mingw64_template\\Debug\\main.o"] )
//  .then( (code) => console.log( "process exited with code", code ) )
//  .catch( (error) => console.error( "there was an error: ", error ) );
//console.log( get_list_of_local_header_files( config.source_dir, "c:\\wkcpp2\\mingw64_template\\src\\main.cpp" ) );


