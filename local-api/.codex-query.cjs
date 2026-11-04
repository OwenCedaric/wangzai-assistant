const Database=require('./node_modules/better-sqlite3');
const db=new Database(process.env.APPDATA+'/wangzai-desktop/local-api-data/wangzai-local-api.sqlite',{readonly:true,fileMustExist:true});
console.log(db.prepare("select name from sqlite_master where type='table' order by name").all().map(x=>x.name).join('\n'));
db.close();
