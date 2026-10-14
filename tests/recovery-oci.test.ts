import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('recovery OCI export preserves the immutable graph and refuses altered or foreign blobs', () => {
  const converter = fileURLToPath(new URL('../scripts/recovery/oci-archive.py', import.meta.url));
  const result = execFileSync('python3', ['-B', '-c', String.raw`
import gzip,hashlib,importlib.util,io,json,pathlib,sys,tarfile,tempfile
spec=importlib.util.spec_from_file_location('oci',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def descriptor(value,kind):
 data=json.dumps(value,separators=(',',':')).encode()
 return {'mediaType':kind,'digest':'sha256:'+hashlib.sha256(data).hexdigest(),'size':len(data)},data
layer_raw=io.BytesIO()
with tarfile.open(fileobj=layer_raw,mode='w') as layer_tar:
 info=tarfile.TarInfo('fixture.txt');data=b'qualification layer';info.size=len(data);layer_tar.addfile(info,io.BytesIO(data))
layer_bytes=gzip.compress(layer_raw.getvalue(),mtime=0)
layer={'mediaType':'application/vnd.oci.image.layer.v1.tar+gzip','digest':'sha256:'+hashlib.sha256(layer_bytes).hexdigest(),'size':len(layer_bytes)}
config,config_bytes=descriptor({'os':'linux','architecture':'amd64','config':{},'rootfs':{'type':'layers','diff_ids':['sha256:'+hashlib.sha256(layer_raw.getvalue()).hexdigest()]}},'application/vnd.oci.image.config.v1+json')
manifest,manifest_bytes=descriptor({'schemaVersion':2,'config':config,'layers':[layer]},'application/vnd.oci.image.manifest.v1+json')
root,root_bytes=descriptor({'schemaVersion':2,'manifests':[{**manifest,'platform':{'os':'linux','architecture':'amd64'}}]},'application/vnd.oci.image.index.v1+json')
with tempfile.TemporaryDirectory(prefix='gthf-recovery-oci-') as directory:
 p=pathlib.Path(directory)
 def archive(name,tamper=False):
  with tarfile.open(p/name,'w') as output:
   entries={'index.json':json.dumps({'schemaVersion':2,'manifests':[root]}).encode(),'manifest.json':b'[{"RepoTags":null}]','oci-layout':b'{"imageLayoutVersion":"1.0.0"}'}
   for d,b in [(root,root_bytes),(manifest,manifest_bytes),(config,config_bytes),(layer,layer_bytes)]: entries['blobs/sha256/'+d['digest'].split(':')[1]]=b
   if tamper: entries['blobs/sha256/'+config['digest'].split(':')[1]]=config_bytes.replace(b'amd64',b'arm64')
   for name,data in entries.items():
    info=tarfile.TarInfo(name);info.size=len(data);output.addfile(info,io.BytesIO(data))
 archive('docker.tar')
 graph=module.convert(str(p/'docker.tar'),str(p/'oci.tar'),'gthf-fixture@'+root['digest'])
 assert graph['digest']==root['digest'] and graph['runtimeManifestDigest']==manifest['digest'] and graph['runtimeConfigDigest']==config['digest']
 with tarfile.open(p/'oci.tar') as output:
  assert 'manifest.json' not in output.getnames()
  exported=json.load(output.extractfile('index.json'))['manifests'][0]
  assert exported['digest']==root['digest'] and exported['annotations']['io.containerd.image.name']=='docker.io/library/gthf-fixture@'+root['digest']
 runtime_graph=module.convert(str(p/'oci.tar'),str(p/'runtime.tar'),'gthf-fixture@'+root['digest'],runtime_only=True)
 assert runtime_graph['sourceDigest']==root['digest'] and runtime_graph['digest']==manifest['digest']
 assert runtime_graph['runtimeConfigDigest']==config['digest']
 with tarfile.open(p/'runtime.tar') as output:
  exported=json.load(output.extractfile('index.json'))['manifests'][0]
  assert exported['digest']==manifest['digest'] and exported['size']==manifest['size']
  assert exported['mediaType']=='application/vnd.oci.image.manifest.v1+json'
  assert exported['annotations']['io.containerd.image.name']=='docker.io/library/gthf-fixture@'+manifest['digest']
  for d,b in [(root,root_bytes),(manifest,manifest_bytes),(config,config_bytes),(layer,layer_bytes)]:
   assert output.extractfile('blobs/sha256/'+d['digest'].split(':')[1]).read()==b
 # The original immutable archive and root are untouched.
 with tarfile.open(p/'oci.tar') as original:
  assert json.load(original.extractfile('index.json'))['manifests'][0]['digest']==root['digest']
 archive('tampered.tar',True)
 for source,ref,label in [('tampered.tar',root['digest'],'tampered'),('docker.tar','sha256:'+'0'*64,'foreign')]:
  for runtime_only in (False,True):
   try: module.convert(str(p/source),str(p/(label+str(runtime_only)+'.tar')),'gthf-fixture@'+ref,runtime_only=runtime_only)
   except ValueError: pass
   else: raise AssertionError(label+' accepted')
 print('exact-root exact-runtime-root unchanged-blobs runtime-config named-OCI tampered-refused foreign-refused')
`, converter], { encoding: 'utf8' });
  assert.equal(result.trim(), 'exact-root exact-runtime-root unchanged-blobs runtime-config named-OCI tampered-refused foreign-refused');
});
